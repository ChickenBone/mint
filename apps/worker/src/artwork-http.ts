import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyToken } from "@mint/core/crypto";
import { getDb, schema } from "@mint/core/db";
import { UUID } from "@mint/core/playback";
import { eq } from "drizzle-orm";
import { loadTrackArtwork } from "./artwork";

export async function serveArtwork(req: IncomingMessage, res: ServerResponse, trackId: string) {
  res.setHeader("cache-control", "no-store");
  const claim = verifyToken<{ trackId: string }>("artwork", req.headers.authorization?.replace(/^Bearer /, ""));
  if (!UUID.test(trackId) || !claim || claim.trackId !== trackId) return void res.writeHead(401).end();
  const [track] = await getDb().select({
    id: schema.tracks.id, plexRatingKey: schema.tracks.plexRatingKey, artworkUrl: schema.tracks.artworkUrl,
    youtubeVideoId: schema.tracks.youtubeVideoId, mbReleaseGroupId: schema.tracks.mbReleaseGroupId,
  }).from(schema.tracks).where(eq(schema.tracks.id, trackId)).limit(1);
  if (!track) return void res.writeHead(404).end();
  const image = await loadTrackArtwork(track);
  if (!image) return void res.writeHead(404).end();
  res.writeHead(200, {
    "content-type": image.type, "content-length": image.bytes.length, "x-content-type-options": "nosniff",
    "cache-control": `public, max-age=${image.maxAge}, stale-while-revalidate=86400`, etag: image.etag,
  });
  res.end(req.method === "HEAD" ? undefined : image.bytes);
}
