import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  LibraryFileAccessError,
  openLibraryMediaFileReadOnly,
  type PersistedLibraryRoot,
  type PersistedMediaFile,
} from "../src/index";

test("confines read-only file access to the persisted Library root", async (t) => {
  const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "mint-library-path-access-"));
  const rootDirectory = path.join(fixtureDirectory, "root");
  const outsideDirectory = path.join(fixtureDirectory, "outside");
  const mediaDirectory = path.join(rootDirectory, "album");
  const mediaPath = path.join(mediaDirectory, "track.flac");
  const outsidePath = path.join(outsideDirectory, "outside.flac");
  const missingRootPath = path.join(fixtureDirectory, "missing-root");
  const contents = "fixture audio bytes";
  const outsideContents = "outside fixture";

  await Promise.all([mkdir(mediaDirectory, { recursive: true }), mkdir(outsideDirectory)]);
  await Promise.all([
    writeFile(mediaPath, contents),
    writeFile(outsidePath, outsideContents),
  ]);
  await symlink(outsideDirectory, path.join(rootDirectory, "escape"), "dir");

  t.after(async () => {
    await rm(rootDirectory, { recursive: true, force: true });
    assert.equal(await readFile(outsidePath, "utf8"), outsideContents);
    await rm(outsideDirectory, { recursive: true, force: true });
    await rmdir(fixtureDirectory);
  });

  const root: PersistedLibraryRoot = { id: "root-id", path: rootDirectory };
  const mediaFile: PersistedMediaFile = { rootId: root.id, relativePath: "album/track.flac" };

  const opened = await openLibraryMediaFileReadOnly(root, mediaFile);
  const buffer = Buffer.alloc(64);
  const { bytesRead } = await opened.read(buffer, 0, buffer.length, 0);
  assert.equal(buffer.subarray(0, bytesRead).toString(), contents);
  assert.deepEqual(Object.keys(opened).sort(), ["close", "read"]);
  assert.equal("write" in opened, false);
  assert.equal("writeFile" in opened, false);
  await opened.close();
  assert.equal(await readFile(mediaPath, "utf8"), contents);

  const expectCode = async (operation: Promise<unknown>, code: LibraryFileAccessError["code"]) => {
    await assert.rejects(operation, (error: unknown) =>
      error instanceof LibraryFileAccessError && error.code === code);
  };

  await expectCode(
    openLibraryMediaFileReadOnly(root, { ...mediaFile, relativePath: "../outside/outside.flac" }),
    "INVALID_RELATIVE_PATH",
  );
  await expectCode(
    openLibraryMediaFileReadOnly(root, { ...mediaFile, relativePath: outsidePath }),
    "INVALID_RELATIVE_PATH",
  );
  await expectCode(
    openLibraryMediaFileReadOnly(root, { ...mediaFile, relativePath: "escape/outside.flac" }),
    "PATH_ESCAPES_ROOT",
  );
  await expectCode(
    openLibraryMediaFileReadOnly(root, { ...mediaFile, relativePath: "album/missing.flac" }),
    "FILE_UNAVAILABLE",
  );
  await expectCode(
    openLibraryMediaFileReadOnly(root, { ...mediaFile, relativePath: "album" }),
    "NOT_REGULAR_FILE",
  );
  await expectCode(
    openLibraryMediaFileReadOnly({ ...root, path: missingRootPath }, mediaFile),
    "ROOT_UNAVAILABLE",
  );

  assert.equal(await realpath(outsidePath), outsidePath);
  assert.equal(await readFile(outsidePath, "utf8"), outsideContents);
});
