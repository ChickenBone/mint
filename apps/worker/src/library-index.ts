import { stat } from "node:fs/promises";
import { getDb, schema } from "@mint/core/db";
import { getRedis } from "@mint/core/redis";
import { eq, sql } from "drizzle-orm";
import { config } from "./config";
import { libraryMatchKey, mapLibraryPath } from "./library-policy";
import { log } from "./log";
import * as plex from "./services/plex";

export interface LibraryIndexStatus {
  state: "disabled" | "indexing" | "ready" | "error";
  indexed: number;
  skipped: number;
  total?: number;
  message?: string;
  checkedAt: string;
}

export const libraryIndexEnabled = () => process.env.INDEX_EXISTING_LIBRARY === "true";
let active = false;

async function report(status: Omit<LibraryIndexStatus, "checkedAt">) {
  await getRedis().set("mint:library-index", JSON.stringify({ ...status, checkedAt: new Date().toISOString() }));
}

export async function indexLibrary() {
  if (!libraryIndexEnabled()) return;
  if (active) return;
  active = true;
  let indexed = 0;
  let skipped = 0;
  try {
    if (!config.plexEnabled) throw new Error("Set a valid PLEX_URL, PLEX_TOKEN and PLEX_MUSIC_SECTION_ID to index the existing library.");
    const root = process.env.EXISTING_PLEX_MUSIC_DIR;
    if (!root) throw new Error("Set EXISTING_PLEX_MUSIC_DIR to the existing music folder as seen by Plex.");
    if (!(await stat(config.existingMusicDir)).isDirectory()) throw new Error("Existing music mount is not a directory.");
    const mid = await plex.serverId();
    const db = getDb();
    const section = process.env.PLEX_MUSIC_SECTION_ID!;
    await report({ state: "indexing", indexed, skipped });
    for (let offset = 0; ; ) {
      const page = await plex.libraryPage(offset);
      if (!page.items.length) break;
      const rows: Array<typeof schema.tracks.$inferInsert> = [];
      for (const item of page.items) {
        const media = item.Media?.[0];
        const part = media?.Part?.[0];
        if (!part?.file || !item.grandparentTitle || !item.title) { skipped++; continue; }
        let localPath: string;
        try {
          localPath = mapLibraryPath(part.file, root, config.existingMusicDir);
        } catch {
          skipped++;
          continue;
        }
        try {
          if (!(await stat(localPath)).isFile()) { skipped++; continue; }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") { skipped++; continue; }
          throw new Error("Cannot read the mounted existing music files. Check NAS folder access permissions.");
        }
        rows.push({
          title: item.title,
          artist: item.grandparentTitle,
          album: item.parentTitle,
          year: item.year,
          durationSec: item.duration ? Math.round(item.duration / 1000) : null,
          existingLibraryKey: `${mid}:${section}:${item.ratingKey}`,
          existingFilePath: localPath,
          existingCodec: media?.audioCodec ?? null,
          existingDurationSec: item.duration ? Math.round(item.duration / 1000) : null,
          existingSonicAnalyzed: plex.isSonicallyAnalyzed(item),
          libraryMatchKey: libraryMatchKey(item.grandparentTitle, item.title),
          filePath: localPath,
          bytes: part.size ?? null,
          codec: media?.audioCodec ?? null,
          plexRatingKey: item.ratingKey,
          sonicAnalyzed: plex.isSonicallyAnalyzed(item),
          stage: "ready",
          progress: 1,
          readyAt: item.addedAt ? new Date(item.addedAt * 1000) : new Date(0),
          detail: "Existing library (read-only)",
        });
      }
      if (rows.length) {
        await db.insert(schema.tracks).values(rows).onConflictDoUpdate({
          target: schema.tracks.existingLibraryKey,
          set: {
            existingFilePath: sql`excluded.existing_file_path`,
            existingCodec: sql`excluded.existing_codec`,
            existingDurationSec: sql`excluded.existing_duration_sec`,
            existingSonicAnalyzed: sql`excluded.existing_sonic_analyzed`,
            libraryMatchKey: sql`excluded.library_match_key`,
            filePath: sql`case when tracks.file_path = tracks.existing_file_path then excluded.existing_file_path else tracks.file_path end`,
            codec: sql`case when tracks.file_path = tracks.existing_file_path then excluded.codec else tracks.codec end`,
            bytes: sql`case when tracks.file_path = tracks.existing_file_path then excluded.bytes else tracks.bytes end`,
            sonicAnalyzed: sql`case when tracks.file_path = tracks.existing_file_path then excluded.sonic_analyzed else tracks.sonic_analyzed end`,
          },
        });
      }
      indexed += rows.length;
      offset += page.items.length;
      await report({ state: "indexing", indexed, skipped, total: page.total });
      if (page.total !== undefined && offset >= page.total) break;
    }
    if (!indexed && skipped) throw new Error("No existing files were accessible. Check EXISTING_MUSIC_FOLDER and EXISTING_PLEX_MUSIC_DIR before syncing likes.");
    await report({ state: "ready", indexed, skipped });
    log.info({ indexed, skipped }, "existing Plex library indexed (read-only)");
    if (skipped) log.warn({ skipped }, "Some Plex entries were missing metadata or outside EXISTING_PLEX_MUSIC_DIR");
    await getRedis().del("mint:stats");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, indexed, skipped }, "existing library indexing failed");
    await report({ state: "error", indexed, skipped, message });
    throw err;
  } finally {
    active = false;
  }
}
