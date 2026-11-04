import { getDb, schema } from "@mint/core/db";
import { PLAYABLE } from "@mint/core/playback";
import { toTrackView } from "@mint/core/views";
import { and, inArray } from "drizzle-orm";
import { z } from "zod";
import { getUser } from "@/lib/auth";
import { boundedJson, publicUrl } from "@/lib/request";
import { trackPlayerItem } from "@/lib/player-protocol";

export async function POST(request: Request) {
  const headers = { "cache-control": "private, no-store" };
  if (!await getUser()) return Response.json({ error: "Approved membership required" }, { status: 401, headers });
  if (request.headers.get("origin") !== new URL(publicUrl()).origin) return Response.json({ error: "Invalid request origin" }, { status: 403, headers });
  if (Number(request.headers.get("content-length")) > 2_000_000) return Response.json({ error: "Queue too large" }, { status: 413, headers });
  let input: unknown;
  try { input = await boundedJson(request, 2_000_000); } catch { return Response.json({ error: "Invalid JSON or queue exceeds its 2 MB limit" }, { status: 400, headers }); }
  const parsed = z.object({ ids: z.array(z.uuid()).min(1).max(10_000) }).safeParse(input);
  if (!parsed.success) return Response.json({ error: "Invalid track queue" }, { status: 400, headers });
  const rows = await getDb().select().from(schema.tracks).where(and(PLAYABLE, inArray(schema.tracks.id, [...new Set(parsed.data.ids)])));
  const byId = new Map(rows.map((track) => [track.id, { ...trackPlayerItem(toTrackView(track)), duration: (track.durationSec ?? track.existingDurationSec ?? 0) * 1000 }]));
  if (parsed.data.ids.some((id) => !byId.has(id))) return Response.json({ error: "Some songs are no longer available on this server" }, { status: 409, headers });
  return Response.json({ items: parsed.data.ids.map((id) => byId.get(id)!) }, { headers });
}
