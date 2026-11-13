import { constants as fsConstants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { mediaFiles, roots } from "./schema";

export type PersistedLibraryRoot = Pick<typeof roots.$inferSelect, "id" | "path">;
export type PersistedMediaFile = Pick<typeof mediaFiles.$inferSelect, "rootId" | "relativePath">;

export type LibraryFileAccessErrorCode =
  | "UNSUPPORTED_PLATFORM"
  | "INVALID_ROOT"
  | "INVALID_RELATIVE_PATH"
  | "ROOT_MISMATCH"
  | "ROOT_UNAVAILABLE"
  | "FILE_UNAVAILABLE"
  | "PATH_ESCAPES_ROOT"
  | "NOT_REGULAR_FILE"
  | "FILE_CHANGED"
  | "VERIFICATION_UNAVAILABLE";

export class LibraryFileAccessError extends Error {
  constructor(
    readonly code: LibraryFileAccessErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LibraryFileAccessError";
  }
}

export interface ReadOnlyMediaFile {
  read(
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null,
  ): Promise<{ bytesRead: number; buffer: Uint8Array }>;
  close(): Promise<void>;
}

export interface ReadOnlyMediaFileWithMetadata extends ReadOnlyMediaFile {
  metadata(): Promise<{ sizeBytes: number; isRegularFile: boolean }>;
}

function isWithinRoot(rootPath: string, targetPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath !== ""
    && relativePath !== ".."
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath);
}

function sameFile(left: Awaited<ReturnType<FileHandle["stat"]>>, right: Awaited<ReturnType<typeof stat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readonlyHandle(handle: FileHandle): ReadOnlyMediaFileWithMetadata {
  let closed = false;
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    metadata: async () => {
      if (closed) throw new Error("The media file handle is closed");
      const info = await handle.stat();
      return { sizeBytes: info.size, isRegularFile: info.isFile() };
    },
    read: (buffer: Uint8Array, offset?: number, length?: number, position?: number | null) => {
      if (closed) {
        return Promise.reject(new Error("The media file handle is closed"));
      }
      return handle.read(buffer, offset, length, position);
    },
    close: () => {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = handle.close();
      return closePromise;
    },
  });
}

export async function openLibraryMediaFileReadOnly(
  root: PersistedLibraryRoot,
  mediaFile: PersistedMediaFile,
): Promise<ReadOnlyMediaFileWithMetadata> {
  if (process.platform !== "linux") {
    throw new LibraryFileAccessError(
      "UNSUPPORTED_PLATFORM",
      "Confined Library file access is currently supported only on Linux",
    );
  }
  if (root.id !== mediaFile.rootId) {
    throw new LibraryFileAccessError("ROOT_MISMATCH", "The media file does not belong to this Library root");
  }
  if (!root.path.trim() || !path.isAbsolute(root.path) || root.path.includes("\0")) {
    throw new LibraryFileAccessError("INVALID_ROOT", "The Library root path must be an absolute filesystem path");
  }

  const segments = mediaFile.relativePath.split("/");
  if (
    !mediaFile.relativePath
    || mediaFile.relativePath.includes("\0")
    || mediaFile.relativePath.includes("\\")
    || path.posix.isAbsolute(mediaFile.relativePath)
    || path.win32.isAbsolute(mediaFile.relativePath)
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new LibraryFileAccessError("INVALID_RELATIVE_PATH", "The media path must be a normalized relative path");
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root.path);
    const rootInfo = await stat(canonicalRoot);
    if (!rootInfo.isDirectory()) {
      throw new LibraryFileAccessError("ROOT_UNAVAILABLE", "The configured Library root is not a directory");
    }
  } catch (error) {
    if (error instanceof LibraryFileAccessError) throw error;
    throw new LibraryFileAccessError("ROOT_UNAVAILABLE", "The configured Library root is unavailable", { cause: error });
  }

  const requestedPath = path.join(canonicalRoot, ...segments);
  let canonicalFile: string;
  let expectedInfo: Awaited<ReturnType<typeof stat>>;
  try {
    canonicalFile = await realpath(requestedPath);
    if (!isWithinRoot(canonicalRoot, canonicalFile)) {
      throw new LibraryFileAccessError("PATH_ESCAPES_ROOT", "The media path resolves outside its Library root");
    }
    expectedInfo = await stat(canonicalFile);
    if (!expectedInfo.isFile()) {
      throw new LibraryFileAccessError("NOT_REGULAR_FILE", "The media target is not a regular file");
    }
  } catch (error) {
    if (error instanceof LibraryFileAccessError) throw error;
    throw new LibraryFileAccessError("FILE_UNAVAILABLE", "The media file is unavailable", { cause: error });
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(canonicalFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile() || !sameFile(openedInfo, expectedInfo)) {
      throw new LibraryFileAccessError("FILE_CHANGED", "The media file changed while it was being opened");
    }

    let openedPath: string;
    try {
      openedPath = await realpath(`/proc/self/fd/${handle.fd}`);
    } catch (error) {
      throw new LibraryFileAccessError(
        "VERIFICATION_UNAVAILABLE",
        "The opened media file descriptor could not be verified",
        { cause: error },
      );
    }
    if (!isWithinRoot(canonicalRoot, openedPath)) {
      throw new LibraryFileAccessError("PATH_ESCAPES_ROOT", "The opened media file is outside its Library root");
    }
    return readonlyHandle(handle);
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        throw new AggregateError([error, closeError], "Library file verification failed and its handle could not be closed");
      }
    }
    if (error instanceof LibraryFileAccessError) throw error;
    throw new LibraryFileAccessError("FILE_UNAVAILABLE", "The media file could not be opened safely", { cause: error });
  }
}
