import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  LibraryFileAccessError,
  LibraryRepositoryInputError,
  scanLibraryRoot,
  type LibraryScanOptions,
  type LibraryScanRepository,
  type MediaVerificationOutcome,
} from "../src/index";

const options: LibraryScanOptions = {
  maxEntries: 100, maxFiles: 50, maxDepth: 8, timeoutMs: 30_000,
  audio: {
    ffprobePath: "/usr/bin/ffprobe", ffmpegPath: "/usr/bin/ffmpeg",
    maxProbeInputBytes: 1024 * 1024, maxDecodeInputBytes: 1024 * 1024,
    maxOutputBytes: 1024 * 1024, probeTimeoutMs: 5000, decodeTimeoutMs: 5000,
  },
};

function wave(): Buffer {
  const frames = 441;
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(44100, 24);
  buffer.writeUInt32LE(88200, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(frames * 2, 40);
  return buffer;
}

async function fixture() {
  const parent = await mkdtemp("/tmp/mint-scan-");
  const music = path.join(parent, "music");
  await mkdir(music);
  const root = { id: randomUUID(), path: music };
  const files = new Map<string, {
    id: string;
    relativePath: string;
    outcome?: MediaVerificationOutcome;
    tags?: { title?: string | null; artist?: string | null; album?: string | null };
  }>();
  const repository: LibraryScanRepository = {
    async getScanRoot(id) { return id === root.id ? root : null; },
    async ensureScanMediaFile(rootId, relativePath) {
      assert.equal(rootId, root.id);
      const previous = files.get(relativePath);
      if (previous) return { id: previous.id, created: false };
      const file = { id: randomUUID(), relativePath };
      files.set(relativePath, file);
      return { id: file.id, created: true };
    },
    async getVerificationTarget(id) {
      const file = [...files.values()].find((candidate) => candidate.id === id);
      return file ? { root, mediaFile: { rootId: root.id, relativePath: file.relativePath } } : null;
    },
    async recordVerification(id, outcome) {
      const file = [...files.values()].find((candidate) => candidate.id === id);
      assert.ok(file);
      file.outcome = outcome;
    },
    async importVerifiedAudioTags(id, _checkedAt, tags) {
      const file = [...files.values()].find((candidate) => candidate.id === id);
      assert.ok(file);
      file.tags = tags;
    },
  };
  return { parent, music, root, files, repository, cleanup: () => rm(parent, { recursive: true, force: true }) };
}

async function assertClosed(prefix: string): Promise<void> {
  for (const descriptor of await readdir("/proc/self/fd")) {
    try {
      const target = await readlink(`/proc/self/fd/${descriptor}`);
      assert.ok(!target.startsWith(prefix), `Scan leaked descriptor ${descriptor}`);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
}

test("repeated scans reuse identities, verify untagged audio and never modify originals or follow symlinks", async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.music, "album"));
    await writeFile(path.join(f.music, "album", "untagged.WAV"), wave());
    await writeFile(path.join(f.music, "cover.jpg"), "not audio");
    await writeFile(path.join(f.parent, "outside.wav"), wave());
    await symlink(f.parent, path.join(f.music, "escape"));
    await symlink(f.music, path.join(f.music, "cycle"));
    await symlink(path.join(f.parent, "outside.wav"), path.join(f.music, "escape.wav"));
    await symlink(path.join(f.music, "album", "untagged.WAV"), path.join(f.music, "alias.wav"));
    const first = await scanLibraryRoot(f.repository, f.root.id, options);
    assert.equal(first.status, "completed");
    assert.equal(first.entriesVisited, 7);
    assert.equal(first.skippedSymlinks, 4);
    assert.equal(first.skippedFiles, 1);
    assert.equal(first.imported, 1);
    assert.equal(first.verified, 1);
    assert.equal(first.issueCount, 0);
    const before = structuredClone([...f.files.values()]);
    const second = await scanLibraryRoot(f.repository, f.root.id, options);
    assert.equal(second.existing, 1);
    assert.equal(second.imported, 0);
    assert.equal(second.verified, 1);
    assert.equal([...f.files.values()][0]?.id, before[0]?.id);
    assert.deepEqual(await readFile(path.join(f.music, "album", "untagged.WAV")), wave());
    await assertClosed(f.parent);
  } finally { await f.cleanup(); }
});

test("mount loss and empty mounted roots retain prior identities and positive evidence", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.music, "original.wav"), wave());
    await scanLibraryRoot(f.repository, f.root.id, options);
    const before = structuredClone([...f.files.values()]);
    await rename(f.music, path.join(f.parent, "detached"));
    const missing = await scanLibraryRoot(f.repository, f.root.id, options);
    assert.equal(missing.status, "root-unavailable");
    assert.equal(missing.issueCount, 1);
    assert.deepEqual([...f.files.values()], before);
    await mkdir(f.music);
    assert.equal((await scanLibraryRoot(f.repository, f.root.id, options)).status, "completed");
    assert.deepEqual([...f.files.values()], before);
    await assertClosed(f.parent);
  } finally { await f.cleanup(); }
});

test("entry, file and depth budgets bound traversal and writes", async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.music, "deep"));
    await writeFile(path.join(f.music, "deep", "nested.wav"), wave());
    await writeFile(path.join(f.music, "one.wav"), wave());
    await writeFile(path.join(f.music, "two.wav"), wave());
    const shallow = await scanLibraryRoot(f.repository, f.root.id, { ...options, maxDepth: 0 });
    assert.equal(shallow.status, "partial");
    assert.equal(shallow.skippedDirectories, 1);
    assert.equal(shallow.filesVisited, 2);
    assert.equal(f.files.has("deep/nested.wav"), false);
    const entryBound = await scanLibraryRoot(f.repository, f.root.id, { ...options, maxEntries: 1 });
    assert.equal(entryBound.status, "limited");
    assert.equal(entryBound.stopReason, "entry-limit");
    assert.equal(entryBound.entriesVisited, 1);
    const fileBound = await scanLibraryRoot(f.repository, f.root.id, { ...options, maxFiles: 1 });
    assert.equal(fileBound.status, "limited");
    assert.equal(fileBound.stopReason, "file-limit");
    assert.equal(fileBound.filesVisited, 1);
    assert.equal(fileBound.verified, 1);
    await assertClosed(f.parent);
  } finally { await f.cleanup(); }
});

test("pre-cancellation and cancellation after identity admission never persist negative observations", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.music, "original.wav"), wave());
    const abort = new AbortController();
    abort.abort();
    const pre = await scanLibraryRoot(f.repository, f.root.id, { ...options, signal: abort.signal });
    assert.equal(pre.status, "cancelled");
    assert.equal(f.files.size, 0);
    const during = new AbortController();
    const result = await scanLibraryRoot({
      ...f.repository,
      async ensureScanMediaFile(rootId, relativePath) {
        const file = await f.repository.ensureScanMediaFile(rootId, relativePath);
        during.abort();
        return file;
      },
    }, f.root.id, { ...options, signal: during.signal });
    assert.equal(result.status, "cancelled");
    assert.equal(result.imported, 1);
    assert.equal([...f.files.values()][0]?.outcome, undefined);
    assert.ok(result.nextCursor);
    const retry = await scanLibraryRoot(f.repository, f.root.id, { ...options, cursor: result.nextCursor, maxReplayEntries: 0 });
    assert.equal(retry.imported, 0);
    assert.equal(retry.existing, 1);
    assert.equal(retry.verified, 1);
    assert.equal(retry.nextCursor, undefined);
    await assertClosed(f.parent);
  } finally { await f.cleanup(); }
});

test("cooperative deadline cancels verification and retains existing evidence", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.music, "original.wav"), wave());
    await scanLibraryRoot(f.repository, f.root.id, options);
    const before = structuredClone([...f.files.values()]);
    const result = await scanLibraryRoot({
      ...f.repository,
      async getVerificationTarget(id) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return f.repository.getVerificationTarget(id);
      },
    }, f.root.id, { ...options, timeoutMs: 10 });
    assert.equal(result.status, "limited");
    assert.equal(result.stopReason, "time-limit");
    assert.equal(result.inconclusive, 1);
    assert.deepEqual([...f.files.values()], before);
    assert.ok(result.nextCursor);
    const retry = await scanLibraryRoot(f.repository, f.root.id, { ...options, cursor: result.nextCursor });
    assert.equal(retry.existing, 1);
    assert.equal(retry.verified, 1);
    await assertClosed(f.parent);
  } finally { await f.cleanup(); }
});

test("inconclusive decode/tool failures preserve positive evidence", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.music, "original.wav"), wave());
    await scanLibraryRoot(f.repository, f.root.id, options);
    const before = structuredClone([...f.files.values()]);
    const result = await scanLibraryRoot(f.repository, f.root.id, {
      ...options, audio: { ...options.audio, ffmpegPath: path.join(f.parent, "missing-ffmpeg") },
    });
    assert.equal(result.inconclusive, 1);
    assert.equal(result.unavailable, 0);
    assert.deepEqual([...f.files.values()], before);
    await assertClosed(f.parent);
  } finally { await f.cleanup(); }
});

test("file disappearance after discovery preserves identity with a definitive unavailable observation", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.music, "original.wav"), wave());
    const result = await scanLibraryRoot({
      ...f.repository,
      async ensureScanMediaFile(rootId, relativePath) {
        const file = await f.repository.ensureScanMediaFile(rootId, relativePath);
        await rm(path.join(f.music, relativePath));
        return file;
      },
    }, f.root.id, options);
    assert.equal(result.unavailable, 1);
    assert.equal(f.files.size, 1);
    const outcome = [...f.files.values()][0]?.outcome;
    assert.equal(outcome?.availability, "unavailable");
    if (outcome?.availability === "unavailable") assert.equal(outcome.reason, "missing");
    await assertClosed(f.parent);
  } finally { await f.cleanup(); }
});

test("root symlinks and unreadable directories fail explicitly without erasing identities", async () => {
  const f = await fixture();
  try {
    await rename(f.music, path.join(f.parent, "actual"));
    await symlink(path.join(f.parent, "actual"), f.music);
    assert.equal((await scanLibraryRoot(f.repository, f.root.id, options)).status, "root-unavailable");
    await rm(f.music);
    await rename(path.join(f.parent, "actual"), f.music);
    await mkdir(path.join(f.music, "denied"), { mode: 0o000 });
    assert.notEqual(process.getuid?.(), 0, "Unreadable-directory proof requires an unprivileged user");
    const denied = await scanLibraryRoot(f.repository, f.root.id, options);
    assert.equal(denied.status, "partial");
    assert.equal(denied.issueCount, 1);
    await chmod(path.join(f.music, "denied"), 0o700);
    await assertClosed(f.parent);
  } finally { await f.cleanup(); }
});

test("path replacement with an escaping symlink fails closed and closes traversal handles", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.music, "original.wav"), wave());
    await writeFile(path.join(f.parent, "outside.wav"), wave());
    await assert.rejects(scanLibraryRoot({
      ...f.repository,
      async ensureScanMediaFile(rootId, relativePath) {
        const file = await f.repository.ensureScanMediaFile(rootId, relativePath);
        await rm(path.join(f.music, relativePath));
        await symlink(path.join(f.parent, "outside.wav"), path.join(f.music, relativePath));
        return file;
      },
    }, f.root.id, options), (error) => error instanceof LibraryFileAccessError && error.code === "PATH_ESCAPES_ROOT");
    assert.equal([...f.files.values()][0]?.outcome, undefined);
    await assertClosed(f.parent);
  } finally { await f.cleanup(); }
});

test("moving an opened directory outside the root stops admission of subsequent files", async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.music, "album"));
    await writeFile(path.join(f.music, "album", "one.wav"), wave());
    await writeFile(path.join(f.music, "album", "two.wav"), wave());
    let moved = false;
    await assert.rejects(scanLibraryRoot({
      ...f.repository,
      async ensureScanMediaFile(rootId, relativePath) {
        const file = await f.repository.ensureScanMediaFile(rootId, relativePath);
        if (!moved) {
          moved = true;
          await rename(path.join(f.music, "album"), path.join(f.parent, "detached-album"));
        }
        return file;
      },
    }, f.root.id, options), (error) => error instanceof LibraryFileAccessError && error.code === "PATH_ESCAPES_ROOT");
    assert.equal(f.files.size, 1);
    await assertClosed(f.parent);
  } finally { await f.cleanup(); }
});

test("cancellation after a positive write reports cancellation without undoing verified evidence", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.music, "original.wav"), wave());
    const abort = new AbortController();
    const result = await scanLibraryRoot({
      ...f.repository,
      async recordVerification(id, outcome) {
        await f.repository.recordVerification(id, outcome);
        abort.abort();
      },
    }, f.root.id, { ...options, signal: abort.signal });
    assert.equal(result.status, "cancelled");
    assert.equal(result.stopReason, "cancelled");
    assert.equal(result.inconclusive, 1);
    assert.equal(result.issueCount, 0);
    assert.equal([...f.files.values()][0]?.outcome?.availability, "verified");
    assert.ok(result.nextCursor);
    const retry = await scanLibraryRoot(f.repository, f.root.id, { ...options, cursor: result.nextCursor });
    assert.equal(retry.existing, 1);
    assert.equal(retry.verified, 1);
    await assertClosed(f.parent);
  } finally { await f.cleanup(); }
});

test("tiny entry/file batches cover a larger nested tree once, with bounded replay and no leaked handles", async () => {
  const f = await fixture();
  try {
    const expected = ["a/deep/deep.wav", "a/one.wav", "a/two.wav", "b/three.wav", "b/four.wav", "five.wav"];
    await mkdir(path.join(f.music, "a", "deep"), { recursive: true });
    await mkdir(path.join(f.music, "b"));
    for (const relativePath of expected) await writeFile(path.join(f.music, relativePath), wave());
    await writeFile(path.join(f.music, "cover.jpg"), "cover");
    await symlink(path.join(f.music, "five.wav"), path.join(f.music, "alias.wav"));
    await symlink(f.parent, path.join(f.music, "escape"));
    await symlink(f.music, path.join(f.music, "cycle"));
    let cursor: string | undefined;
    let entries = 0;
    let imported = 0;
    let verified = 0;
    let skippedSymlinks = 0;
    let skippedFiles = 0;
    let completed = false;
    for (let invocation = 0; invocation < 30; invocation++) {
      const result = await scanLibraryRoot(f.repository, f.root.id, {
        ...options, maxEntries: 1, maxFiles: 1, cursor,
      });
      assert.ok(result.entriesVisited <= 1);
      assert.ok(result.filesVisited <= 1);
      assert.ok(result.replayedEntries <= 100_000);
      assert.equal(result.issueCount, 0);
      assert.equal(result.existing, 0);
      entries += result.entriesVisited;
      imported += result.imported;
      verified += result.verified;
      skippedSymlinks += result.skippedSymlinks;
      skippedFiles += result.skippedFiles;
      cursor = result.nextCursor;
      await assertClosed(f.parent);
      if (!cursor) {
        assert.equal(result.status, "completed");
        completed = true;
        break;
      }
      assert.equal(result.status, "limited");
      assert.ok(Buffer.byteLength(cursor) <= 1024 * 1024);
    }
    assert.ok(completed, "Continuation must terminate rather than repeatedly scan the root prefix");
    assert.equal(entries, 13);
    assert.equal(imported, expected.length);
    assert.equal(verified, expected.length);
    assert.equal(skippedSymlinks, 3);
    assert.equal(skippedFiles, 1);
    assert.deepEqual([...f.files.keys()].sort(), expected.sort());
    for (const relativePath of expected) assert.deepEqual(await readFile(path.join(f.music, relativePath)), wave());
  } finally { await f.cleanup(); }
});

test("replay budgets are separate, exact, actionable and enforced before repository access", async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 5; index++) await writeFile(path.join(f.music, `${index}.txt`), "");
    const first = await scanLibraryRoot(f.repository, f.root.id, { ...options, maxEntries: 2 });
    assert.ok(first.nextCursor);
    let lookups = 0;
    const repository = {
      ...f.repository,
      async getScanRoot(id: string) { lookups++; return f.repository.getScanRoot(id); },
    };
    await assert.rejects(scanLibraryRoot(repository, f.root.id, {
      ...options, cursor: first.nextCursor, maxReplayEntries: 1,
    }), /replay exceeds maxReplayEntries; increase that budget/);
    assert.equal(lookups, 0);
    const second = await scanLibraryRoot(repository, f.root.id, {
      ...options, maxEntries: 1, cursor: first.nextCursor, maxReplayEntries: 2,
    });
    assert.equal(second.entriesVisited, 1);
    assert.equal(second.replayedEntries, 2);
    assert.ok(second.nextCursor);
    const final = await scanLibraryRoot(repository, f.root.id, {
      ...options, cursor: second.nextCursor, maxReplayEntries: 3,
    });
    assert.equal(final.entriesVisited, 2);
    assert.equal(final.replayedEntries, 3);
    assert.equal(final.status, "completed");
    assert.equal(final.nextCursor, undefined);
    await assertClosed(f.parent);
  } finally { await f.cleanup(); }
});

test("malformed, oversized, unsafe and root/depth-mismatched cursors fail before filesystem/repository work", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.music, "one.txt"), "");
    const first = await scanLibraryRoot(f.repository, f.root.id, { ...options, maxEntries: 1 });
    assert.ok(first.nextCursor);
    const valid = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString("utf8"));
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const frame = valid.frames[0];
    let lookups = 0;
    const repository = {
      ...f.repository,
      async getScanRoot(id: string) { lookups++; return f.repository.getScanRoot(id); },
    };
    for (const cursor of [
      "", "not-a-cursor", "=", "A".repeat(1024 * 1024 + 1), encode(null), encode([]),
      encode({ ...valid, version: 2 }), encode({ ...valid, rootId: randomUUID() }),
      encode({ ...valid, maxDepth: options.maxDepth - 1 }), encode({ ...valid, frames: [] }),
      encode({ ...valid, frames: Array.from({ length: 66 }, () => frame) }),
      encode({ ...valid, frames: [{ ...frame, offset: -1 }] }),
      encode({ ...valid, frames: [{ ...frame, offset: 1.5 }] }),
      encode({ ...valid, frames: [{ ...frame, offset: Number.MAX_SAFE_INTEGER + 1 }] }),
      encode({ ...valid, frames: [{ ...frame, stamp: "untrusted" }] }),
      encode({ ...valid, frames: [{ ...frame, prefix: "bad" }] }),
      encode({ ...valid, frames: [{ ...frame, relativePath: "../escape" }] }),
      ...["../escape", "/escape", "C:/escape", "a\\b", "a//b", "a/./b", "a/../b", "\0", "a/b"].map(
        (relativePath) => encode({ ...valid, frames: [frame, { ...frame, relativePath }] }),
      ),
    ]) {
      await assert.rejects(scanLibraryRoot(repository, f.root.id, { ...options, cursor }), LibraryRepositoryInputError);
    }
    for (const maxReplayEntries of [-1, 1.5, 100_001]) {
      await assert.rejects(scanLibraryRoot(repository, f.root.id, { ...options, maxReplayEntries }), LibraryRepositoryInputError);
    }
    const oversizedReplay = encode({ ...valid, frames: [{ ...frame, offset: 100_001 }] });
    await assert.rejects(scanLibraryRoot(repository, f.root.id, { ...options, cursor: oversizedReplay }), /replay exceeds/);
    assert.equal(lookups, 0);
    assert.equal(f.files.size, 0);
    await assertClosed(f.parent);
  } finally { await f.cleanup(); }
});

test("active directory mutations, substituted roots and symlinks reject stale continuations without writes", async () => {
  for (const mutation of ["add", "remove", "rename", "child-symlink", "root-replacement", "root-config"] as const) {
    const f = await fixture();
    try {
      await mkdir(path.join(f.music, "album"));
      await writeFile(path.join(f.music, "album", "original.wav"), wave());
      const first = await scanLibraryRoot(f.repository, f.root.id, { ...options, maxEntries: 1 });
      assert.ok(first.nextCursor);
      assert.equal(f.files.size, 0);
      // Filesystem timestamps may coalesce rapid mutations within one clock tick.
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (mutation === "add") await writeFile(path.join(f.music, "album", "new.wav"), wave());
      if (mutation === "remove") await rm(path.join(f.music, "album", "original.wav"));
      if (mutation === "rename") await rename(path.join(f.music, "album", "original.wav"), path.join(f.music, "album", "renamed.wav"));
      if (mutation === "child-symlink") {
        await rename(path.join(f.music, "album"), path.join(f.parent, "detached-album"));
        await symlink(path.join(f.parent, "detached-album"), path.join(f.music, "album"));
      }
      if (mutation === "root-replacement") {
        await rename(f.music, path.join(f.parent, "detached"));
        await mkdir(f.music);
      }
      if (mutation === "root-config") {
        await mkdir(path.join(f.parent, "other"));
        f.root.path = path.join(f.parent, "other");
      }
      await assert.rejects(scanLibraryRoot(f.repository, f.root.id, {
        ...options, cursor: first.nextCursor,
      }), /Stale Library scan cursor/, mutation);
      assert.equal(f.files.size, 0);
      await assertClosed(f.parent);
    } finally { await f.cleanup(); }
  }
});

test("cursor prefix validation detects reordered or truncated replay even with matching directory stamps", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.music, "one.txt"), "");
    const first = await scanLibraryRoot(f.repository, f.root.id, { ...options, maxEntries: 1 });
    assert.ok(first.nextCursor);
    const valid = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString("utf8"));
    for (const override of [{ prefix: "0".repeat(64) }, { offset: 2 }]) {
      const cursor = Buffer.from(JSON.stringify({
        ...valid, frames: [{ ...valid.frames[0], ...override }],
      })).toString("base64url");
      await assert.rejects(scanLibraryRoot(f.repository, f.root.id, { ...options, cursor }), /Stale Library scan cursor/);
    }
    assert.equal(f.files.size, 0);
    await assertClosed(f.parent);
  } finally { await f.cleanup(); }
});

test("matching traversal hints cannot bypass fresh symlink and containment checks after unread-suffix changes", async () => {
  for (const mutation of ["addition", "suffix-symlink", "directory-symlink", "file-race"] as const) {
    const f = await fixture();
    try {
      await mkdir(path.join(f.music, "album"));
      await writeFile(path.join(f.music, "album", "original.wav"), wave());
      await writeFile(path.join(f.parent, "outside.wav"), wave());
      const first = await scanLibraryRoot(f.repository, f.root.id, { ...options, maxEntries: 1 });
      assert.ok(first.nextCursor);
      if (mutation === "addition") await writeFile(path.join(f.music, "album", "late.wav"), wave());
      if (mutation === "suffix-symlink") {
        await rm(path.join(f.music, "album", "original.wav"));
        await symlink(path.join(f.parent, "outside.wav"), path.join(f.music, "album", "original.wav"));
      }
      if (mutation === "directory-symlink") {
        await rename(path.join(f.music, "album"), path.join(f.parent, "detached-album"));
        await symlink(path.join(f.parent, "detached-album"), path.join(f.music, "album"));
      }
      const hints = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString("utf8"));
      // Model matching stamps deterministically, without depending on a real clock collision.
      for (const frame of hints.frames) {
        const info = await stat(path.join(f.music, frame.relativePath), { bigint: true });
        frame.stamp = `${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}`;
      }
      const cursor = Buffer.from(JSON.stringify(hints)).toString("base64url");
      const repository: LibraryScanRepository = {
        ...f.repository,
        async ensureScanMediaFile(rootId, relativePath) {
          const file = await f.repository.ensureScanMediaFile(rootId, relativePath);
          if (mutation === "file-race") {
            await rm(path.join(f.music, relativePath));
            await symlink(path.join(f.parent, "outside.wav"), path.join(f.music, relativePath));
          }
          return file;
        },
      };
      if (mutation === "directory-symlink") {
        await assert.rejects(scanLibraryRoot(repository, f.root.id, { ...options, cursor }), /active directory cannot be reopened/);
        assert.equal(f.files.size, 0);
      } else if (mutation === "file-race") {
        await assert.rejects(scanLibraryRoot(repository, f.root.id, { ...options, cursor }),
          (error) => error instanceof LibraryFileAccessError && error.code === "PATH_ESCAPES_ROOT");
        assert.equal(f.files.size, 1);
        assert.equal([...f.files.values()][0]?.outcome, undefined);
      } else {
        const resumed = await scanLibraryRoot(repository, f.root.id, { ...options, cursor });
        assert.equal(resumed.status, "completed");
        assert.equal(resumed.replayedEntries, 1);
        assert.equal(resumed.verified, mutation === "addition" ? 2 : 0);
        assert.equal(resumed.skippedSymlinks, mutation === "suffix-symlink" ? 1 : 0);
        assert.equal(f.files.size, mutation === "addition" ? 2 : 0);
      }
      assert.deepEqual(await readFile(path.join(f.parent, "outside.wav")), wave());
      await assertClosed(f.parent);
    } finally { await f.cleanup(); }
  }
});

test("the maximum-depth continuation stack stays bounded and closes every ancestor", async () => {
  const f = await fixture();
  try {
    const deepest = path.join(f.music, ...Array.from({ length: 64 }, () => "d"));
    await mkdir(path.join(deepest, "skipped"), { recursive: true });
    await writeFile(path.join(deepest, "original.wav"), wave());
    const first = await scanLibraryRoot(f.repository, f.root.id, { ...options, maxDepth: 64, maxEntries: 64 });
    assert.ok(first.nextCursor);
    const hints = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString("utf8"));
    assert.equal(hints.frames.length, 65);
    assert.ok(Buffer.byteLength(first.nextCursor) <= 1024 * 1024);
    assert.equal(first.entriesVisited, 64);
    await assertClosed(f.parent);
    const resumed = await scanLibraryRoot(f.repository, f.root.id, { ...options, maxDepth: 64, cursor: first.nextCursor });
    assert.equal(resumed.replayedEntries, 64);
    assert.equal(resumed.entriesVisited, 2);
    assert.equal(resumed.verified, 1);
    assert.equal(resumed.skippedDirectories, 1);
    assert.equal(resumed.status, "partial");
    assert.equal(resumed.nextCursor, undefined);
    await assertClosed(f.parent);
  } finally { await f.cleanup(); }
});

test("mount loss and pre-cancelled restoration retain the original cursor for retry", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.music, "original.wav"), wave());
    const first = await scanLibraryRoot(f.repository, f.root.id, { ...options, maxFiles: 1 });
    assert.ok(first.nextCursor);
    const before = structuredClone([...f.files.values()]);
    const controller = new AbortController();
    controller.abort();
    const cancelled = await scanLibraryRoot(f.repository, f.root.id, { ...options, cursor: first.nextCursor, signal: controller.signal });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.nextCursor, first.nextCursor);
    assert.equal(cancelled.replayedEntries, 0);
    await rename(f.music, path.join(f.parent, "detached"));
    const missing = await scanLibraryRoot(f.repository, f.root.id, { ...options, cursor: first.nextCursor });
    assert.equal(missing.status, "root-unavailable");
    assert.equal(missing.nextCursor, first.nextCursor);
    assert.deepEqual([...f.files.values()], before);
    await assertClosed(f.parent);
  } finally { await f.cleanup(); }
});

test("file-content mutation is reverified, but changes to completed directories require a fresh scan", async () => {
  const f = await fixture();
  try {
    for (const album of ["a", "b"]) {
      await mkdir(path.join(f.music, album));
      await writeFile(path.join(f.music, album, "original.wav"), wave());
    }
    let cursor: string | undefined;
    let finishedAlbum: string | undefined;
    for (let invocation = 0; invocation < 10; invocation++) {
      const result = await scanLibraryRoot(f.repository, f.root.id, { ...options, maxEntries: 1, cursor });
      cursor = result.nextCursor;
      assert.ok(cursor);
      const checkpoint = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      const admitted = [...f.files.keys()][0];
      if (admitted && checkpoint.frames.length === 2
        && checkpoint.frames[1].relativePath !== path.posix.dirname(admitted)) {
        finishedAlbum = path.posix.dirname(admitted);
        const remainingAlbum = checkpoint.frames[1].relativePath;
        await writeFile(path.join(f.music, remainingAlbum, "original.wav"), "not audio anymore");
        break;
      }
    }
    assert.ok(finishedAlbum);
    await writeFile(path.join(f.music, finishedAlbum, "late.wav"), wave());
    const rest = await scanLibraryRoot(f.repository, f.root.id, { ...options, cursor });
    assert.equal(rest.status, "partial");
    assert.equal(rest.inconclusive, 1);
    assert.equal(rest.nextCursor, undefined);
    assert.equal(f.files.has(`${finishedAlbum}/late.wav`), false);
    const fresh = await scanLibraryRoot(f.repository, f.root.id, options);
    assert.equal(fresh.imported, 1);
    assert.equal(f.files.get(`${finishedAlbum}/late.wav`)?.outcome?.availability, "verified");
    await assertClosed(f.parent);
  } finally { await f.cleanup(); }
});

test("unreadable observed files retain identities and report definitive unavailability", async () => {
  const f = await fixture();
  try {
    assert.notEqual(process.getuid?.(), 0, "Unreadable-file proof requires an unprivileged user");
    const filename = path.join(f.music, "unreadable.wav");
    await writeFile(filename, wave(), { mode: 0o000 });
    const result = await scanLibraryRoot(f.repository, f.root.id, options);
    assert.equal(result.unavailable, 1);
    const outcome = [...f.files.values()][0]?.outcome;
    assert.equal(outcome?.availability, "unavailable");
    if (outcome?.availability === "unavailable") assert.equal(outcome.reason, "unreadable");
    await chmod(filename, 0o600);
    await assertClosed(f.parent);
  } finally { await f.cleanup(); }
});

test("diagnostics remain bounded while retaining the total issue count", async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 105; index++) {
      await writeFile(path.join(f.music, `unsupported\\${index}.wav`), wave());
    }
    const result = await scanLibraryRoot(f.repository, f.root.id, { ...options, maxEntries: 200 });
    assert.equal(result.status, "partial");
    assert.equal(result.issueCount, 105);
    assert.equal(result.issues.length, 100);
    assert.equal(result.imported, 0);
    assert.equal(f.files.size, 0);
    await assertClosed(f.parent);
  } finally { await f.cleanup(); }
});

test("invalid inputs and repository failures are errors, never empty success", async () => {
  const f = await fixture();
  try {
    for (const overrides of [
      { maxEntries: 0 }, { maxEntries: 100_001 }, { maxFiles: 10_001 },
      { maxDepth: 65 }, { maxDepth: -1 }, { timeoutMs: 0 }, { maxFiles: 1.5 },
    ]) {
      await assert.rejects(scanLibraryRoot(f.repository, f.root.id, { ...options, ...overrides }), LibraryRepositoryInputError);
    }
    await assert.rejects(scanLibraryRoot(f.repository, "../root", options), LibraryRepositoryInputError);
    await assert.rejects(scanLibraryRoot(f.repository, randomUUID(), options), LibraryRepositoryInputError);
    await writeFile(path.join(f.music, "original.wav"), wave());
    const failure = new Error("database write failed");
    await assert.rejects(scanLibraryRoot({
      ...f.repository,
      async ensureScanMediaFile() { throw failure; },
    }, f.root.id, options), (error) => error === failure);
    await assertClosed(f.parent);
  } finally { await f.cleanup(); }
});
