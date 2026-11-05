import type { Metadata } from "next";
import { getDb, schema } from "@mint/core/db";
import { musicHistory } from "@mint/core/music-db";
import { spotifyPlaylists } from "@mint/core/spotify-db";
import { spotifyAccountView } from "@mint/core/spotify-store";
import { toTrackView } from "@mint/core/views";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import { getLikedTracks, getPlaylists, getYoutubeAccount } from "@/lib/data";
import { listCollections, musicProfile } from "@/lib/music-store";
import { YourMusic } from "@/components/app/your-music";

export const metadata: Metadata = { title: "Your music" };
export const dynamic = "force-dynamic";

export default async function CollectionHubPage() {
  const user = await requireUser();
  const db = getDb();

  const [
    initialCollections,
    ytPlaylists,
    spPlaylists,
    ytAccount,
    spAccount,
    likedTracks,
    profile,
    historyRows,
  ] = await Promise.all([
    listCollections(db, user.id),
    getPlaylists(user.id),
    db
      .select()
      .from(spotifyPlaylists)
      .where(eq(spotifyPlaylists.userId, user.id))
      .orderBy(asc(spotifyPlaylists.title), asc(spotifyPlaylists.id))
      .limit(100),
    getYoutubeAccount(user.id),
    spotifyAccountView(db, user.id),
    getLikedTracks(user.id),
    musicProfile(db, user.id),
    db
      .select({ event: musicHistory, track: schema.tracks })
      .from(musicHistory)
      .innerJoin(schema.tracks, eq(schema.tracks.id, musicHistory.trackId))
      .where(and(eq(musicHistory.userId, user.id)))
      .orderBy(desc(musicHistory.createdAt), desc(musicHistory.id))
      .limit(101),
  ]);

  const ytIds = ytPlaylists.map((p) => p.id);
  const [readyCounts, excludedRows] = await Promise.all([
    ytIds.length
      ? db
          .select({
            playlistId: schema.playlistTracks.playlistId,
            ready: sql<number>`count(*)::int`,
          })
          .from(schema.playlistTracks)
          .innerJoin(schema.tracks, eq(schema.tracks.id, schema.playlistTracks.trackId))
          .where(
            and(
              inArray(schema.playlistTracks.playlistId, ytIds),
              inArray(schema.tracks.stage, ["ready", "analyzing"]),
            ),
          )
          .groupBy(schema.playlistTracks.playlistId)
      : Promise.resolve([]),
    profile.exclusions.length
      ? db.select().from(schema.tracks).where(inArray(schema.tracks.id, profile.exclusions))
      : Promise.resolve([]),
  ]);

  const readyByPlaylist = new Map(readyCounts.map((r) => [r.playlistId, Number(r.ready)]));

  return (
    <YourMusic
      memberId={user.id}
      initialCollections={initialCollections}
      youtubePlaylists={ytPlaylists.map((p) => ({
        id: p.id,
        title: p.title,
        itemCount: p.itemCount,
        readyCount: readyByPlaylist.get(p.id) ?? 0,
        syncEnabled: p.syncEnabled,
        artworkUrl: p.artworkUrl,
      }))}
      spotifyPlaylists={spPlaylists.map((p) => ({
        id: p.id,
        title: p.title,
        sourceTotal: p.sourceTotal,
        matchedTotal: p.matchedTotal,
        syncEnabled: p.syncEnabled,
        status: p.status,
        error: p.error,
        lastSyncedAt: p.lastSyncedAt ? p.lastSyncedAt.toISOString() : null,
      }))}
      youtubeLinked={Boolean(ytAccount)}
      spotifyLinked={Boolean(spAccount)}
      likedTracks={likedTracks}
      history={{
        entries: historyRows.map((r) => ({
          ...r,
          event: { ...r.event, createdAt: r.event.createdAt.toISOString() },
          track: toTrackView(r.track),
        })),
        privateSession: profile.privateSession,
        excluded: excludedRows.map(toTrackView),
      }}
    />
  );
}
