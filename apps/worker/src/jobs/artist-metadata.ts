import { getDb, schema } from "@mint/core/db";
import type { ArtistMetadataJob } from "@mint/core";
import { eq, sql } from "drizzle-orm";
import type { Job } from "bullmq";
import { createHash } from "node:crypto";
import { log } from "../log";
import { queues } from "../queues";
import { fetchArtistMetadata } from "../services/artist-metadata";

const DAY = 24 * 60 * 60 * 1000;

export async function scheduleArtistMetadata() {
  const { rows } = await getDb().execute<{ artist_name: string }>(sql`
    select distinct t.artist as artist_name
    from tracks t
    left join artist_metadata m on m.artist_name = t.artist
    where length(trim(t.artist)) between 1 and 1000
      and (
        m.artist_name is null
        or m.status = 'queued'
        or (m.status in ('ready', 'not_found', 'ambiguous', 'failed')
          and coalesce(m.next_attempt_at, 'epoch'::timestamptz) <= now())
        or (m.status = 'fetching' and m.updated_at < now() - interval '10 minutes')
      )
    order by t.artist
    limit 10
  `);
  for (const { artist_name: artistName } of rows) {
    await getDb().insert(schema.artistMetadata).values({ artistName, status: "queued" })
      .onConflictDoUpdate({
        target: schema.artistMetadata.artistName,
        set: { status: "queued", lastError: null, nextAttemptAt: null, updatedAt: new Date() },
      });
    const id = createHash("sha256").update(artistName).digest("hex");
    await queues.artistMetadata.add("enrich-artist", { artistName }, { jobId: `artist-${id}` });
  }
  return rows.length;
}

export async function processArtistMetadata(job: Job<ArtistMetadataJob>) {
  const artistName = job.data.artistName.trim();
  if (!artistName || artistName.length > 1000) throw new Error("Invalid artist metadata job");
  const db = getDb();
  const known = await db.select({ id: schema.tracks.mbArtistId }).from(schema.tracks)
    .where(sql`${schema.tracks.artist} = ${artistName} and ${schema.tracks.mbArtistId} is not null`)
    .limit(20);
  const knownIds = [...new Set(known.flatMap(({ id }) => id ? [id] : []))];
  await db.update(schema.artistMetadata).set({
    status: "fetching",
    attempts: sql`${schema.artistMetadata.attempts} + 1`,
    lastError: null,
    updatedAt: new Date(),
  }).where(eq(schema.artistMetadata.artistName, artistName));

  try {
    const result = await fetchArtistMetadata(artistName, knownIds);
    const now = new Date();
    const refreshDays = result.status === "not_found" ? 90 : 30;
    await db.update(schema.artistMetadata).set({
      musicBrainzArtistId: result.musicBrainzArtistId,
      status: result.status,
      profile: result.profile,
      lastError: result.status === "ready" && result.profile.unavailableSources.length
        ? `Unavailable sources: ${result.profile.unavailableSources.join(", ")}`
        : null,
      fetchedAt: now,
      nextAttemptAt: new Date(now.getTime() + refreshDays * DAY),
      updatedAt: now,
    }).where(eq(schema.artistMetadata.artistName, artistName));
    log.info({ artistName, status: result.status }, "artist metadata enrichment finished");
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "Metadata provider request failed";
    await db.update(schema.artistMetadata).set({
      status: "failed",
      lastError: message,
      nextAttemptAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
      updatedAt: new Date(),
    }).where(eq(schema.artistMetadata.artistName, artistName));
    log.warn({ err: error, artistName }, "artist metadata enrichment failed; the queue will retry");
    throw error;
  }
}
