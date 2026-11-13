import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { Dir, Dirent } from "node:fs";
import { open, opendir, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { LibraryFileAccessError, type PersistedLibraryRoot } from "./path-access";
import {
  createLibraryRepository,
  LibraryMediaWriteError,
  LibraryRepositoryInputError,
  type LibraryRepository,
} from "./repository";
import { mediaFiles, roots } from "./schema";
import { verifyLibraryMediaFile } from "./verify-media-file";
import type { AudioProbeOptions } from "./audio-probe";

export const LIBRARY_SCAN_AUDIO_EXTENSIONS: readonly string[] = Object.freeze([
  ".aac", ".aif", ".aiff", ".alac", ".ape", ".flac", ".m4a", ".mp3",
  ".oga", ".ogg", ".opus", ".wav", ".wave", ".wma", ".wv",
]);

export interface LibraryScanRepository extends Pick<
  LibraryRepository, "getVerificationTarget" | "recordVerification" | "importVerifiedAudioTags"
> {
  getScanRoot(rootId: string): Promise<PersistedLibraryRoot | null>;
  ensureScanMediaFile(rootId: string, relativePath: string): Promise<{ id: string; created: boolean }>;
}

function requireRootId(id: string): void {
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new LibraryRepositoryInputError("Expected a Library root UUID");
  }
}

/** Target-only adapter. Conflicts preserve every existing identity, tag and observation. */
export function createLibraryScanRepository(
  db: Parameters<typeof createLibraryRepository>[0],
): LibraryScanRepository {
  const repository = createLibraryRepository(db);
  return {
    getVerificationTarget: repository.getVerificationTarget,
    recordVerification: repository.recordVerification,
    importVerifiedAudioTags: repository.importVerifiedAudioTags,
    async getScanRoot(rootId) {
      requireRootId(rootId);
      const [root] = await db.select({ id: roots.id, path: roots.path }).from(roots)
        .where(eq(roots.id, rootId)).limit(1);
      return root ?? null;
    },
    async ensureScanMediaFile(rootId, relativePath) {
      requireRootId(rootId);
      if (typeof relativePath !== "string" || !relativePath.trim()
        || relativePath.includes("\0") || relativePath.includes("\\")
        || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)
        || relativePath.split("/").some((part) => part === "" || part === "." || part === "..")) {
        throw new LibraryRepositoryInputError("A scan media path must be a normalized relative path");
      }
      const [created] = await db.insert(mediaFiles).values({ rootId, relativePath })
        .onConflictDoNothing({ target: [mediaFiles.rootId, mediaFiles.relativePath] })
        .returning({ id: mediaFiles.id });
      if (created) return { ...created, created: true };
      const [existing] = await db.select({ id: mediaFiles.id }).from(mediaFiles)
        .where(and(eq(mediaFiles.rootId, rootId), eq(mediaFiles.relativePath, relativePath))).limit(1);
      if (!existing) throw new LibraryMediaWriteError("The conflicting Library scan identity disappeared");
      return { ...existing, created: false };
    },
  };
}

export interface LibraryScanOptions {
  /** Bounds apply to newly visited entries/files, excluding bounded cursor replay. */
  maxEntries: number;
  maxFiles: number;
  /** Root entries have depth zero. Deeper directories are skipped, not reconciled. */
  maxDepth: number;
  /** Cooperative deadline, not a hard filesystem/SQL timeout. */
  timeoutMs: number;
  audio: Omit<AudioProbeOptions, "signal">;
  signal?: AbortSignal;
  /** Private worker state from nextCursor; not authorization or a browser DTO. */
  cursor?: string;
  /** Directory entries reread to restore a cursor. Defaults to 100,000; maximum 100,000. */
  maxReplayEntries?: number;
}

export interface LibraryScanResult {
  /** Status, counters and issues describe this invocation, not the entire resumed traversal. */
  status: "completed" | "partial" | "limited" | "cancelled" | "root-unavailable";
  stopReason?: "entry-limit" | "file-limit" | "time-limit" | "cancelled";
  entriesVisited: number;
  replayedEntries: number;
  /** Persist only after the invocation succeeds. Aborted, unfinished files are retried. */
  nextCursor?: string;
  filesVisited: number;
  imported: number;
  existing: number;
  verified: number;
  unavailable: number;
  inconclusive: number;
  skippedSymlinks: number;
  skippedFiles: number;
  skippedDirectories: number;
  issueCount: number;
  /** Trusted worker diagnostics only, never a browser DTO. At most 100 entries. */
  issues: { relativePath: string; error: unknown }[];
}

function validateOptions(options: LibraryScanOptions): void {
  for (const [name, value, min, max] of [
    ["maxEntries", options.maxEntries, 1, 100_000],
    ["maxFiles", options.maxFiles, 1, 10_000],
    ["maxDepth", options.maxDepth, 0, 64],
    ["timeoutMs", options.timeoutMs, 1, 3_600_000],
    ["maxReplayEntries", options.maxReplayEntries === undefined ? 100_000 : options.maxReplayEntries, 0, 100_000],
  ] as const) {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new LibraryRepositoryInputError(`Library scan ${name} must be an integer from ${min} to ${max}`);
    }
  }
}

interface ScanFrame {
  relativePath: string;
  offset: number;
  stamp: string;
  prefix: string;
}

interface ScanCursor {
  version: 1;
  rootId: string;
  rootPath: string;
  maxDepth: number;
  frames: ScanFrame[];
}

const MAX_CURSOR_BYTES = 1024 * 1024;

function invalidCursor(message = "Malformed Library scan cursor"): never {
  throw new LibraryRepositoryInputError(message);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseCursor(options: LibraryScanOptions, rootId: string): ScanCursor | undefined {
  const encoded = options.cursor;
  if (encoded === undefined) return undefined;
  if (typeof encoded !== "string" || !encoded.length
    || Buffer.byteLength(encoded) > MAX_CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    invalidCursor();
  }
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded) invalidCursor();
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { invalidCursor(); }
  if (!object(value) || value.version !== 1 || value.rootId !== rootId
    || value.maxDepth !== options.maxDepth || typeof value.rootPath !== "string"
    || value.rootPath.length > 4096 || value.rootPath.includes("\0") || !path.isAbsolute(value.rootPath)
    || !Array.isArray(value.frames) || !value.frames.length || value.frames.length > options.maxDepth + 1) {
    invalidCursor("Malformed or root/depth-mismatched Library scan cursor");
  }
  const frames: ScanFrame[] = [];
  let remainingReplay = options.maxReplayEntries ?? 100_000;
  for (const candidate of value.frames) {
    if (!object(candidate) || typeof candidate.relativePath !== "string" || candidate.relativePath.length > 4096
      || typeof candidate.offset !== "number" || !Number.isSafeInteger(candidate.offset) || candidate.offset < 0
      || typeof candidate.stamp !== "string" || candidate.stamp.length > 160
      || !/^\d+:\d+:-?\d+:-?\d+$/.test(candidate.stamp)
      || typeof candidate.prefix !== "string"
      || (candidate.offset === 0 ? candidate.prefix !== "" : !/^[a-f0-9]{64}$/.test(candidate.prefix))) {
      invalidCursor();
    }
    const relativePath = candidate.relativePath;
    const parent = frames.at(-1);
    if (!parent ? relativePath !== "" : (
      !parent.offset || !relativePath || relativePath.includes("\\") || relativePath.includes("\0")
      || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)
      || relativePath.split("/").some((part) => !part.trim() || part === "." || part === "..")
      || path.posix.dirname(relativePath) !== (parent.relativePath || ".")
    )) invalidCursor();
    if (candidate.offset > remainingReplay) {
      invalidCursor("Library scan cursor replay exceeds maxReplayEntries; increase that budget up to 100000 or start a fresh scan with larger traversal budgets");
    }
    remainingReplay -= candidate.offset;
    frames.push({ relativePath, offset: candidate.offset, stamp: candidate.stamp, prefix: candidate.prefix });
  }
  return { version: 1, rootId, rootPath: value.rootPath, maxDepth: options.maxDepth, frames };
}

async function directoryStamp(handle: FileHandle): Promise<string> {
  const info = await handle.stat({ bigint: true });
  return `${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}`;
}

function entryPrefix(prefix: string, entry: Dirent): string {
  const type = entry.isDirectory() ? "d" : entry.isFile() ? "f" : entry.isSymbolicLink() ? "l" : "o";
  return createHash("sha256").update(prefix).update("\0").update(entry.name).update("\0").update(type).digest("hex");
}

async function descriptorPath(handle: FileHandle): Promise<string> {
  try {
    return await realpath(`/proc/self/fd/${handle.fd}`);
  } catch (error) {
    throw new LibraryFileAccessError("VERIFICATION_UNAVAILABLE", "The scan directory descriptor cannot be verified", { cause: error });
  }
}

function withinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative);
}

/**
 * Explicit local-worker import of an existing persisted root. Never modifies originals,
 * infers recordings, follows discovered symlinks or sweeps absent files. Repeated calls
 * reuse root/path identities. Persist nextCursor to continue a stopped scan, including
 * across process restarts. Replay rereads active directory prefixes (not seek-efficient),
 * with a separate bounded budget; very large prefixes can exceed the replay cap and
 * require a fresh scan with larger traversal budgets. Cursor size is capped at 1 MiB
 * and the stack at 65. Changed active directory identities/stamps or replayed prefixes
 * reject stale cursors, but timestamp collisions can hide unread-suffix changes.
 * Additions to completed directories require a fresh scan. Cursor data is only a
 * traversal hint: confinement and file checks are always fresh. No snapshot or full
 * fairness guarantee is provided. Callers serialize scans per root and own checkpoints/retries;
 * failed invocations can replay writes idempotently. There is no worker lease, schedule
 * or freshness policy. Filesystem/SQL calls and cleanup are not hard-abortable.
 */
export async function scanLibraryRoot(
  repository: LibraryScanRepository,
  rootId: string,
  options: LibraryScanOptions,
): Promise<LibraryScanResult> {
  validateOptions(options);
  requireRootId(rootId);
  const cursor = parseCursor(options, rootId);
  if (process.platform !== "linux") {
    throw new LibraryFileAccessError("UNSUPPORTED_PLATFORM", "Confined Library scanning requires Linux");
  }
  const result: LibraryScanResult = {
    status: "completed", entriesVisited: 0, replayedEntries: 0, filesVisited: 0, imported: 0, existing: 0,
    verified: 0, unavailable: 0, inconclusive: 0, skippedSymlinks: 0,
    skippedFiles: 0, skippedDirectories: 0, issueCount: 0, issues: [],
  };
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  function stopped(): boolean {
    if (!signal.aborted) return result.stopReason !== undefined;
    result.status = options.signal?.aborted ? "cancelled" : "limited";
    result.stopReason = options.signal?.aborted ? "cancelled" : "time-limit";
    return true;
  }
  function issue(relativePath: string, error: unknown): void {
    result.issueCount++;
    if (result.issues.length < 100) result.issues.push({ relativePath, error });
    if (result.status === "completed") result.status = "partial";
  }
  let rootHandle: FileHandle | undefined;
  const stack: { state: ScanFrame; handle: FileHandle; directory?: Dir }[] = [];
  let restored = false;
  try {
    if (stopped()) return result;
    const root = await repository.getScanRoot(rootId);
    if (!root) throw new LibraryRepositoryInputError("The persisted Library scan root does not exist");
    if (cursor && cursor.rootPath !== root.path) invalidCursor("Stale Library scan cursor: configured root changed; start a fresh scan");
    if (stopped()) return result;
    if (!path.isAbsolute(root.path) || root.path.includes("\0")) {
      throw new LibraryFileAccessError("INVALID_ROOT", "The persisted scan root must be an absolute path without NUL");
    }
    try {
      rootHandle = await open(root.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch (error) {
      issue("", error);
      result.status = "root-unavailable";
      stopped();
      return result;
    }
    const canonicalRoot = await descriptorPath(rootHandle);
    const audio = { ...options.audio, signal };

    async function checkDirectory(handle: FileHandle, relativeDirectory: string): Promise<void> {
      const directoryPath = await descriptorPath(handle);
      if (relativeDirectory ? !withinRoot(canonicalRoot, directoryPath) : directoryPath !== canonicalRoot) {
        throw new LibraryFileAccessError("PATH_ESCAPES_ROOT", "The scan directory moved outside its Library root");
      }
    }

    async function closeFrame(): Promise<void> {
      const frame = stack.pop();
      if (!frame) return;
      try { await frame.directory?.close(); } finally {
        if (frame.handle !== rootHandle) await frame.handle.close();
      }
    }

    const initial: ScanFrame = { relativePath: "", offset: 0, stamp: await directoryStamp(rootHandle), prefix: "" };
    stack.push({ state: cursor?.frames[0] ?? initial, handle: rootHandle });
    if (cursor) {
      // Validate every active ancestor before admitting any new identities.
      for (let index = 0; index < cursor.frames.length; index++) {
        if (stopped()) return result;
        const state = cursor.frames[index]!;
        if (index > 0) {
          const parent = stack.at(-1)!;
          let handle;
          try {
            handle = await open(`/proc/self/fd/${parent.handle.fd}/${path.posix.basename(state.relativePath)}`,
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          } catch (error) {
            const stale = new LibraryRepositoryInputError("Stale Library scan cursor: active directory cannot be reopened; start a fresh scan");
            stale.cause = error;
            throw stale;
          }
          stack.push({ state, handle });
        }
        const frame = stack.at(-1)!;
        await checkDirectory(frame.handle, state.relativePath);
        if (await directoryStamp(frame.handle) !== state.stamp) {
          invalidCursor("Stale Library scan cursor: active directory changed; start a fresh scan");
        }
      }
      for (const frame of stack) {
        if (stopped()) return result;
        frame.directory = await opendir(`/proc/self/fd/${frame.handle.fd}`, { bufferSize: 1 });
        let prefix = "";
        for (let index = 0; index < frame.state.offset; index++) {
          if (stopped()) return result;
          const entry = await frame.directory.read();
          if (!entry) invalidCursor("Stale Library scan cursor: directory prefix disappeared; start a fresh scan");
          result.replayedEntries++;
          prefix = entryPrefix(prefix, entry);
        }
        if (prefix !== frame.state.prefix || await directoryStamp(frame.handle) !== frame.state.stamp) {
          invalidCursor("Stale Library scan cursor: directory prefix changed; start a fresh scan");
        }
      }
    }
    restored = true;
    while (stack.length && !stopped()) {
      const frame = stack.at(-1)!;
      const { handle, state } = frame;
      const relativeDirectory = state.relativePath;
      const depth = stack.length - 1;
      await checkDirectory(handle, relativeDirectory);
      if (!frame.directory) {
        try { frame.directory = await opendir(`/proc/self/fd/${handle.fd}`, { bufferSize: 1 }); } catch (error) {
          issue(relativeDirectory, error);
          await closeFrame();
          continue;
        }
      }
      if (result.entriesVisited >= options.maxEntries || result.filesVisited >= options.maxFiles) {
        result.status = "limited";
        result.stopReason = result.entriesVisited >= options.maxEntries ? "entry-limit" : "file-limit";
        break;
      }
      let entry;
      try {
        entry = await frame.directory.read();
      } catch (error) {
        issue(relativeDirectory, error);
        await closeFrame();
        continue;
      }
      if (stopped()) break;
      if (!entry) {
        await closeFrame();
        continue;
      }
      await checkDirectory(handle, relativeDirectory);
      if (stopped()) break;
      result.entriesVisited++;
      function consume(): void {
        state.offset++;
        state.prefix = entryPrefix(state.prefix, entry!);
      }
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        result.skippedSymlinks++;
      } else if (entry.name.includes("\\") || !entry.name.trim()) {
        issue(relativePath, new LibraryRepositoryInputError("The filesystem name is not a supported Library path"));
      } else if (entry.isDirectory()) {
        if (depth >= options.maxDepth) {
          result.skippedDirectories++;
          if (result.status === "completed") result.status = "partial";
          consume();
          continue;
        }
        let child;
        try {
          child = await open(`/proc/self/fd/${handle.fd}/${entry.name}`,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        } catch (error) {
          issue(relativePath, error);
          consume();
          continue;
        }
        const childFrame = { state: { relativePath, offset: 0, stamp: "", prefix: "" }, handle: child };
        stack.push(childFrame);
        childFrame.state.stamp = await directoryStamp(child);
        consume();
        continue;
      } else if (entry.isFile() && LIBRARY_SCAN_AUDIO_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
        if (stopped()) break;
        result.filesVisited++;
        const file = await repository.ensureScanMediaFile(rootId, relativePath);
        if (file.created) result.imported++;
        else result.existing++;
        if (stopped()) break;
        const verification = await verifyLibraryMediaFile(repository, file.id, audio);
        result[verification.status]++;
        if (verification.status === "inconclusive" && verification.reason !== "cancelled") {
          issue(relativePath, new Error(`Library audio verification is inconclusive: ${verification.reason}`));
        }
        if (stopped()) break;
      } else {
        result.skippedFiles++;
      }
      consume();
    }
    stopped();
    if (stack.length) {
      const checkpoint: ScanCursor = {
        version: 1, rootId, rootPath: root.path, maxDepth: options.maxDepth,
        frames: stack.map((frame) => frame.state),
      };
      result.nextCursor = Buffer.from(JSON.stringify(checkpoint)).toString("base64url");
      if (Buffer.byteLength(result.nextCursor) > MAX_CURSOR_BYTES) invalidCursor("Library scan cursor exceeds its encoded-byte limit");
    }
    return result;
  } finally {
    clearTimeout(timer);
    if (!restored && cursor) result.nextCursor = options.cursor;
    // Close all ancestors even when one cleanup operation fails.
    const errors: unknown[] = [];
    for (const frame of stack.reverse()) {
      try { await frame.directory?.close(); } catch (error) { errors.push(error); }
      if (frame.handle !== rootHandle) {
        try { await frame.handle.close(); } catch (error) { errors.push(error); }
      }
    }
    try { await rootHandle?.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Library scan handles could not be closed");
  }
}
