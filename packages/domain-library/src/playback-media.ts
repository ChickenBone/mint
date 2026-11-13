import path from "node:path";
import { LibraryFileAccessError, openLibraryMediaFileReadOnly } from "./path-access";
import type { LibraryRepository } from "./repository";

export const LIBRARY_MEDIA_READ_MAX_BYTES = 64 * 1024;

export type LibraryPlaybackMediaErrorCode =
  | "NOT_FOUND" | "NOT_VERIFIED" | "FILE_UNAVAILABLE" | "UNSUPPORTED_ORIGINAL_FORMAT"
  | "INVALID_METADATA" | "METADATA_UNAVAILABLE" | "CLOSED" | "CANCELLED" | "UNEXPECTED_EOF";

export class LibraryPlaybackMediaError extends Error {
  constructor(readonly code: LibraryPlaybackMediaErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LibraryPlaybackMediaError";
  }
}

export interface LibraryMediaByteRange {
  status: 200 | 206;
  start: number;
  end: number;
  length: number;
  totalSize: number;
  contentRange: string | null;
}

export class LibraryMediaRangeError extends Error {
  readonly status = 416;
  readonly contentRange: string;

  constructor(readonly totalSize: number) {
    super("The requested single byte range is not satisfiable");
    this.name = "LibraryMediaRangeError";
    this.contentRange = `bytes */${totalSize}`;
  }
}

export function parseLibraryMediaByteRange(header: string | undefined, totalSize: number): LibraryMediaByteRange {
  if (!Number.isSafeInteger(totalSize) || totalSize < 1) {
    throw new RangeError("Media size must be a positive safe integer");
  }
  let start = 0;
  let end = totalSize - 1;
  if (header !== undefined) {
    const invalid = () => new LibraryMediaRangeError(totalSize);
    const match = header.length <= 128 ? /^bytes=(\d*)-(\d*)$/.exec(header) : null;
    if (!match || match[0] !== header || (!match[1] && !match[2])) throw invalid();
    const first = match[1] ? Number(match[1]) : undefined;
    const last = match[2] ? Number(match[2]) : undefined;
    if ((first !== undefined && !Number.isSafeInteger(first))
      || (last !== undefined && !Number.isSafeInteger(last))) throw invalid();
    if (first === undefined) {
      if (last === undefined || last === 0) throw invalid();
      start = Math.max(0, totalSize - last);
    } else {
      start = first;
      end = last === undefined ? end : Math.min(last, end);
    }
    if (start >= totalSize || end < start) throw invalid();
  }
  return {
    status: header === undefined ? 200 : 206, start, end, length: end - start + 1, totalSize,
    contentRange: header === undefined ? null : `bytes ${start}-${end}/${totalSize}`,
  };
}

export interface LibraryPlaybackMedia {
  readonly metadata: Readonly<{ mediaFileId: string; sizeBytes: number; contentType: string }>;
  /** Positional reads allocate at most LIBRARY_MEDIA_READ_MAX_BYTES and never pass the opened size. */
  read(position: number, length: number): Promise<Uint8Array>;
  /** Lazily reads original bytes; early return or cancellation does not transfer close ownership. */
  chunks(rangeHeader?: string): AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}

function originalContentType(relativePath: string, codec: string | null): string {
  const extension = path.posix.extname(relativePath).toLowerCase();
  const types: Readonly<Record<string, { type: string; codecs: readonly string[] }>> = {
    ".mp3": { type: "audio/mpeg", codecs: ["mp3", "mp3float"] },
    ".flac": { type: "audio/flac", codecs: ["flac"] },
    ".m4a": { type: "audio/mp4", codecs: ["aac", "alac"] },
    ".mp4": { type: "audio/mp4", codecs: ["aac", "alac"] },
    ".aac": { type: "audio/aac", codecs: ["aac"] },
    ".ogg": { type: "audio/ogg", codecs: ["vorbis", "opus", "flac"] },
    ".opus": { type: "audio/ogg", codecs: ["opus"] },
  };
  if ((extension === ".wav" || extension === ".wave") && codec
    && (codec.startsWith("pcm_") || codec.startsWith("adpcm_"))) return "audio/wav";
  const format = types[extension];
  if (format && codec && format.codecs.includes(codec)) return format.type;
  throw new LibraryPlaybackMediaError("UNSUPPORTED_ORIGINAL_FORMAT", "This original audio format is not supported");
}

function definiteFileFailure(error: unknown): "missing" | "unreadable" | undefined {
  if (!(error instanceof LibraryFileAccessError) || error.code !== "FILE_UNAVAILABLE") return;
  const cause = error.cause;
  if (!cause || typeof cause !== "object" || !("code" in cause)) return;
  if (cause.code === "ENOENT") return "missing";
  if (cause.code === "EACCES" || cause.code === "EPERM") return "unreadable";
}

/**
 * Trusted local-worker capability, not authorization or an HTTP error boundary.
 * The caller must enforce fresh persisted-session policy and close, including on errors/cancellation.
 * Cancellation gates reads; an already pending filesystem operation is not hard-abortable.
 */
export async function openLibraryPlaybackMedia(
  repository: Pick<LibraryRepository, "getPlaybackTarget" | "recordVerification">,
  mediaFileId: string,
  options: { signal?: AbortSignal } = {},
): Promise<LibraryPlaybackMedia> {
  const checkCancelled = () => {
    if (options.signal?.aborted) throw new LibraryPlaybackMediaError("CANCELLED", "Media reading was cancelled");
  };
  checkCancelled();
  const target = await repository.getPlaybackTarget(mediaFileId);
  checkCancelled();
  if (!target) throw new LibraryPlaybackMediaError("NOT_FOUND", "The persisted Library media file does not exist");
  if (target.availability !== "verified") {
    throw new LibraryPlaybackMediaError("NOT_VERIFIED", "The Library media file is not verified as available");
  }
  const checkedAt = new Date();
  let handle;
  try {
    handle = await openLibraryMediaFileReadOnly(target.root, target.mediaFile);
  } catch (error) {
    checkCancelled();
    const reason = definiteFileFailure(error);
    if (!reason) throw error;
    await repository.recordVerification(mediaFileId, { availability: "unavailable", checkedAt, reason });
    throw new LibraryPlaybackMediaError("FILE_UNAVAILABLE", "The Library media file is unavailable");
  }
  try {
    checkCancelled();
    let info;
    try {
      info = await handle.metadata();
    } catch (error) {
      throw new LibraryPlaybackMediaError("METADATA_UNAVAILABLE", "Opened media metadata could not be read", { cause: error });
    }
    checkCancelled();
    if (!info.isRegularFile || !Number.isSafeInteger(info.sizeBytes) || info.sizeBytes < 0) {
      throw new LibraryPlaybackMediaError("INVALID_METADATA", "Opened media must be a regular file with a safe byte size");
    }
    if (info.sizeBytes === 0) {
      await repository.recordVerification(mediaFileId, { availability: "unavailable", checkedAt, reason: "invalid_audio" });
      throw new LibraryPlaybackMediaError("FILE_UNAVAILABLE", "The Library media file is empty");
    }
    const contentType = originalContentType(target.mediaFile.relativePath, target.audioCodec);
    const metadata = Object.freeze({ mediaFileId, sizeBytes: info.sizeBytes, contentType });
    const opened = handle;
    let closed = false;
    let closePromise: Promise<void> | undefined;
    const read = async (position: number, length: number): Promise<Uint8Array> => {
      if (closed) throw new LibraryPlaybackMediaError("CLOSED", "The media reader is closed");
      checkCancelled();
      if (!Number.isSafeInteger(position) || position < 0 || position >= metadata.sizeBytes
        || !Number.isSafeInteger(length) || length < 1 || length > LIBRARY_MEDIA_READ_MAX_BYTES) {
        throw new RangeError("Media reads require a valid position and bounded positive length");
      }
      const buffer = new Uint8Array(Math.min(length, metadata.sizeBytes - position));
      const { bytesRead } = await opened.read(buffer, 0, buffer.length, position);
      checkCancelled();
      if (closed) throw new LibraryPlaybackMediaError("CLOSED", "The media reader is closed");
      if (bytesRead === 0) throw new LibraryPlaybackMediaError("UNEXPECTED_EOF", "The opened media ended before its reported size");
      return buffer.subarray(0, bytesRead);
    };
    return Object.freeze({
      metadata,
      read,
      async *chunks(rangeHeader?: string) {
        const range = parseLibraryMediaByteRange(rangeHeader, metadata.sizeBytes);
        let position = range.start;
        while (position <= range.end) {
          const bytes = await read(position, Math.min(LIBRARY_MEDIA_READ_MAX_BYTES, range.end - position + 1));
          position += bytes.length;
          yield bytes;
        }
      },
      close() {
        if (closePromise) return closePromise;
        closed = true;
        closePromise = opened.close();
        return closePromise;
      },
    });
  } catch (error) {
    try {
      await handle.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "Opening Library playback failed and its handle could not be closed");
    }
    throw error;
  }
}
