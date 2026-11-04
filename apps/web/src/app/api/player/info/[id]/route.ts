import { getDb, schema } from "@mint/core/db";
import { PLAYABLE } from "@mint/core/playback";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getUser } from "@/lib/auth";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const headers = { "cache-control": "private, no-store" };
  if (!await getUser()) return Response.json({ error: "Approved membership required" }, { status: 401, headers });
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "Invalid track" }, { status: 400, headers });
  const t = schema.tracks;
  const [track] = await getDb().select({ id: t.id, title: t.title, artist: t.artist, album: t.album, year: t.year, source: t.source,
    codec: t.codec, existingCodec: t.existingCodec, duration: t.durationSec, existingDuration: t.existingDurationSec,
    bytes: t.bytes, createdAt: t.createdAt, plexSonicAnalyzed: t.sonicAnalyzed, existingPlexSonicAnalyzed: t.existingSonicAnalyzed,
    musicbrainzRecordingId: t.mbRecordingId, musicbrainzReleaseGroupId: t.mbReleaseGroupId,
  }).from(t).where(and(eq(t.id, id), PLAYABLE)).limit(1);
  return track ? Response.json({ track }, { headers }) : Response.json({ error: "Track unavailable" }, { status: 404, headers });
}
