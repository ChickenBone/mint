import { recordings } from "@mint/domain-catalog";
import { and, asc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import path from "node:path";
import { mediaFiles, roots } from "./schema";
import type { PersistedLibraryRoot, PersistedMediaFile } from "./path-access";

export const LIBRARY_DEFAULT_PAGE_SIZE = 50;
export const LIBRARY_MAX_PAGE_SIZE = 100;
export const LIBRARY_MAX_SEARCH_LENGTH = 200;

export interface ImportedMediaTags {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  version?: string | null;
}

export interface LibraryFileListItem {
  id: string;
  recordingId: string | null;
  title: string;
  artist: string;
  album: string;
  version: string | null;
  durationMs: number | null;
}

export interface LibraryListInput {
  limit?: number;
  search?: string;
  cursor?: string;
}

export interface LibraryFilePage {
  items: LibraryFileListItem[];
  nextCursor: string | null;
}

// Trusted worker input only: these paths must never be projected into listing DTOs.
export interface LibraryVerificationTarget {
  root: PersistedLibraryRoot;
  mediaFile: PersistedMediaFile;
}

// Trusted local playback only; never expose this filesystem lookup as a client DTO.
export interface LibraryPlaybackTarget extends LibraryVerificationTarget {
  availability: typeof mediaFiles.$inferSelect["availability"];
  audioCodec: string | null;
}

// Only a trusted audio verifier may supply this evidence; opening/statting a file is insufficient.
export type MediaVerificationOutcome =
  | {
    availability: "verified";
    checkedAt: Date;
    audio: { streamIndex: number; codec: string; decodedSampleFrames: number; durationMs?: number | null };
  }
  | {
    availability: "unavailable";
    checkedAt: Date;
    reason: "missing" | "unreadable" | "invalid_audio";
  };

export interface LibraryRepository {
  createRoot(input: { path: string }): Promise<{ id: string }>;
  createMediaFile(input: {
    rootId: string;
    relativePath: string;
    recordingId?: string | null;
    importedTags?: ImportedMediaTags;
  }): Promise<{ id: string }>;
  replaceImportedTags(id: string, tags: ImportedMediaTags): Promise<void>;
  getVerificationTarget(id: string): Promise<LibraryVerificationTarget | null>;
  getPlaybackTarget(id: string): Promise<LibraryPlaybackTarget | null>;
  importVerifiedAudioTags(
    id: string,
    checkedAt: Date,
    tags: Pick<ImportedMediaTags, "title" | "artist" | "album">,
  ): Promise<void>;
  recordVerification(id: string, outcome: MediaVerificationOutcome): Promise<void>;
  listFiles(input?: LibraryListInput): Promise<LibraryFilePage>;
}

export class LibraryRepositoryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryRepositoryInputError";
  }
}

export class LibraryMediaWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryMediaWriteError";
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireUuid(value: string): void {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new LibraryRepositoryInputError("Expected a media, root or recording UUID");
  }
}

function tag(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || value.length > 2000 || value.includes("\0")) {
    throw new LibraryRepositoryInputError("Imported display tags must be text of at most 2000 characters without NUL");
  }
  return value.trim() || null;
}

function tagColumns(tags: ImportedMediaTags) {
  return {
    importedTitle: tag(tags.title), importedArtist: tag(tags.artist),
    importedAlbum: tag(tags.album), importedVersion: tag(tags.version),
  };
}

function normalizeSearch(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/\s+/g, " ");
}

function encodeCursor(after: string, search: string): string {
  return Buffer.from(JSON.stringify({ v: 1, after, search })).toString("base64url");
}

function readInput(input: LibraryListInput) {
  const limit = input.limit === undefined ? LIBRARY_DEFAULT_PAGE_SIZE : input.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIBRARY_MAX_PAGE_SIZE) {
    throw new LibraryRepositoryInputError(`Library page size must be an integer from 1 to ${LIBRARY_MAX_PAGE_SIZE}`);
  }
  if (input.search !== undefined && (
    typeof input.search !== "string" || input.search.length > LIBRARY_MAX_SEARCH_LENGTH || input.search.includes("\0")
  )) {
    throw new LibraryRepositoryInputError(`Library search must be text of at most ${LIBRARY_MAX_SEARCH_LENGTH} characters without NUL`);
  }
  const search = normalizeSearch(input.search ?? "");
  let after: string | undefined;
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== "string" || input.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) {
      throw new LibraryRepositoryInputError("Invalid Library cursor");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
    } catch (error) {
      throw new LibraryRepositoryInputError(`Invalid Library cursor: ${error instanceof Error ? error.message : "decode failed"}`);
    }
    if (decoded === null || typeof decoded !== "object"
      || !("v" in decoded) || decoded.v !== 1
      || !("after" in decoded) || typeof decoded.after !== "string" || !uuidPattern.test(decoded.after)
      || !("search" in decoded) || decoded.search !== search
      || encodeCursor(decoded.after, search) !== input.cursor) {
      throw new LibraryRepositoryInputError("Library cursor does not match this search or ordering");
    }
    after = decoded.after;
  }
  return { limit, search, after };
}

export function createLibraryRepository(
  db: NodePgDatabase<{ roots: typeof roots; mediaFiles: typeof mediaFiles; recordings: typeof recordings }>,
): LibraryRepository {
  const filename = sql<string>`regexp_replace(${mediaFiles.relativePath}, '^.*/', '')`;
  const title = sql<string>`coalesce(nullif(btrim(${mediaFiles.importedTitle}), ''), nullif(btrim(${recordings.title}), ''), nullif(${filename}, ''), 'Unknown title')`;
  const version = sql<string | null>`coalesce(nullif(btrim(${mediaFiles.importedVersion}), ''), nullif(btrim(${recordings.version}), ''))`;
  return {
    async createRoot(input) {
      if (typeof input.path !== "string" || !path.posix.isAbsolute(input.path) || input.path.includes("\0")) {
        throw new LibraryRepositoryInputError("A Library root must have an absolute path without NUL");
      }
      const [created] = await db.insert(roots).values(input).returning({ id: roots.id });
      if (!created) throw new LibraryMediaWriteError("Library root was not created");
      return created;
    },
    async createMediaFile(input) {
      requireUuid(input.rootId);
      if (input.recordingId != null) requireUuid(input.recordingId);
      if (typeof input.relativePath !== "string" || !input.relativePath.trim()
        || input.relativePath.includes("\0") || input.relativePath.includes("\\")
        || path.posix.isAbsolute(input.relativePath) || path.win32.isAbsolute(input.relativePath)
        || input.relativePath.split("/").some((part) => part === "" || part === "." || part === "..")) {
        throw new LibraryRepositoryInputError("A media path must be a normalized relative path");
      }
      const [created] = await db.insert(mediaFiles).values({
        rootId: input.rootId, relativePath: input.relativePath, recordingId: input.recordingId ?? null,
        ...tagColumns(input.importedTags ?? {}),
      }).returning({ id: mediaFiles.id });
      if (!created) throw new LibraryMediaWriteError("Library media file was not created");
      return created;
    },
    async replaceImportedTags(id, tags) {
      requireUuid(id);
      const updated = await db.update(mediaFiles).set(tagColumns(tags))
        .where(eq(mediaFiles.id, id)).returning({ id: mediaFiles.id });
      if (!updated.length) throw new LibraryMediaWriteError("Library media file does not exist");
    },
    async getVerificationTarget(id) {
      requireUuid(id);
      const [target] = await db.select({
        root: { id: roots.id, path: roots.path },
        mediaFile: { rootId: mediaFiles.rootId, relativePath: mediaFiles.relativePath },
      }).from(mediaFiles).innerJoin(roots, eq(mediaFiles.rootId, roots.id))
        .where(eq(mediaFiles.id, id)).limit(1);
      return target ?? null;
    },
    async getPlaybackTarget(id) {
      requireUuid(id);
      const [target] = await db.select({
        root: { id: roots.id, path: roots.path },
        mediaFile: { rootId: mediaFiles.rootId, relativePath: mediaFiles.relativePath },
        availability: mediaFiles.availability,
        audioCodec: mediaFiles.audioCodec,
      }).from(mediaFiles).innerJoin(roots, eq(mediaFiles.rootId, roots.id))
        .where(eq(mediaFiles.id, id)).limit(1);
      return target ?? null;
    },
    async importVerifiedAudioTags(id, checkedAt, tags) {
      requireUuid(id);
      if (!(checkedAt instanceof Date) || !Number.isFinite(checkedAt.getTime())) {
        throw new LibraryRepositoryInputError("Imported audio tags require a valid verification timestamp");
      }
      const updated = await db.update(mediaFiles).set({
        importedTitle: sql`coalesce(${tag(tags.title)}, ${mediaFiles.importedTitle})`,
        importedArtist: sql`coalesce(${tag(tags.artist)}, ${mediaFiles.importedArtist})`,
        importedAlbum: sql`coalesce(${tag(tags.album)}, ${mediaFiles.importedAlbum})`,
      }).where(and(
        eq(mediaFiles.id, id), eq(mediaFiles.availability, "verified"), eq(mediaFiles.checkedAt, checkedAt),
      )).returning({ id: mediaFiles.id });
      if (!updated.length) throw new LibraryMediaWriteError("Library audio tags require the current positive verification");
    },
    async recordVerification(id, outcome) {
      requireUuid(id);
      if (!(outcome.checkedAt instanceof Date) || !Number.isFinite(outcome.checkedAt.getTime())) {
        throw new LibraryRepositoryInputError("Verification requires a valid check timestamp");
      }
      const where = and(eq(mediaFiles.id, id), or(isNull(mediaFiles.checkedAt), lte(mediaFiles.checkedAt, outcome.checkedAt)));
      let updates: Partial<typeof mediaFiles.$inferInsert>;
      if (outcome.availability === "verified") {
        const audio = outcome.audio;
        if (!audio || !Number.isInteger(audio.streamIndex) || audio.streamIndex < 0 || audio.streamIndex > 2147483647
          || typeof audio.codec !== "string" || !audio.codec.trim() || audio.codec.length > 200 || audio.codec.includes("\0")
          || !Number.isInteger(audio.decodedSampleFrames) || audio.decodedSampleFrames < 1 || audio.decodedSampleFrames > 2147483647
          || (audio.durationMs != null && (!Number.isInteger(audio.durationMs) || audio.durationMs < 1 || audio.durationMs > 2147483647))) {
          throw new LibraryRepositoryInputError("Positive verification requires an audio stream, codec and decoded sample frames");
        }
        updates = {
          availability: "verified", checkedAt: outcome.checkedAt, verifiedAt: outcome.checkedAt, unavailableReason: null,
          audioStreamIndex: audio.streamIndex, audioCodec: audio.codec.trim(),
          decodedSampleFrames: audio.decodedSampleFrames, durationMs: audio.durationMs ?? null,
        };
      } else if (outcome.availability === "unavailable" && ["missing", "unreadable", "invalid_audio"].includes(outcome.reason)) {
        updates = { availability: "unavailable", checkedAt: outcome.checkedAt, unavailableReason: outcome.reason };
      } else {
        throw new LibraryRepositoryInputError("Invalid verification outcome");
      }
      const updated = await db.update(mediaFiles).set(updates).where(where).returning({ id: mediaFiles.id });
      if (!updated.length) throw new LibraryMediaWriteError("Library media file is absent or verification is older than its persisted check");
    },
    async listFiles(input = {}) {
      const { limit, search, after } = readInput(input);
      const searchable = sql`lower(regexp_replace(normalize(concat_ws(' ', ${title}, ${mediaFiles.importedArtist},
        ${mediaFiles.importedAlbum}, ${version}, ${recordings.title}, ${filename}), NFD), U&'[\\0300-\\036f]', '', 'g'))`;
      const rows = await db.select({
        id: mediaFiles.id, recordingId: mediaFiles.recordingId, title,
        artist: sql<string>`coalesce(nullif(btrim(${mediaFiles.importedArtist}), ''), 'Unknown artist')`,
        album: sql<string>`coalesce(nullif(btrim(${mediaFiles.importedAlbum}), ''), 'Unknown album')`,
        version,
        durationMs: sql<number | null>`coalesce(${mediaFiles.durationMs}, ${recordings.durationMs})`,
      }).from(mediaFiles).leftJoin(recordings, eq(mediaFiles.recordingId, recordings.id))
        .where(and(
          eq(mediaFiles.availability, "verified"),
          after ? gt(mediaFiles.id, after) : undefined,
          ...search.split(" ").filter(Boolean).map((token) =>
            sql`${searchable} LIKE ${`%${token.replace(/[\\%_]/g, "\\$&")}%`}`),
        )).orderBy(asc(mediaFiles.id)).limit(limit + 1);
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.id, search) : null };
    },
  };
}
