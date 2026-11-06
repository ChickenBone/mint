import type { Metadata } from "next";
import { getDb, schema } from "@mint/core/db";
import { musicHistory } from "@mint/core/music-db";
import { toTrackView } from "@mint/core/views";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import { getPlaylists, getUserMusicTracks, getUserSummary } from "@/lib/data";
import { importedLikeCandidates, listCollections, musicProfile } from "@/lib/music-store";
import { YourMusic } from "@/components/app/your-music";

export const metadata: Metadata = { title: "Your Library" };
export const dynamic = "force-dynamic";

export default async function CollectionHubPage() {
  const user = await requireUser();
  const db = getDb();

  const [
    initialCollections,
    importPlaylists,
    profile,
    historyRows,
    backlogSummary,
    backlogTracks,
    importedLikes,
  ] = await Promise.all([
    listCollections(db, user.id),
    getPlaylists(user.id),
    musicProfile(db, user.id),
    db
      .select({ event: musicHistory, track: schema.tracks })
      .from(musicHistory)
      .innerJoin(schema.tracks, eq(schema.tracks.id, musicHistory.trackId))
      .where(and(eq(musicHistory.userId, user.id)))
      .orderBy(desc(musicHistory.createdAt), desc(musicHistory.id))
      .limit(101),
    getUserSummary(user.id),
    getUserMusicTracks(user.id, 500),
    importedLikeCandidates(db, user.id),
  ]);

  const excludedRows = profile.exclusions.length
    ? await db.select().from(schema.tracks).where(inArray(schema.tracks.id, profile.exclusions))
    : [];

  return (
    <YourMusic
      memberId={user.id}
      initialCollections={initialCollections}
      importPlaylists={importPlaylists.map((p) => ({
        id: p.id,
        title: p.title,
      }))}
      backlogSummary={backlogSummary}
      backlogTracks={backlogTracks}
      importedLikes={{ tracks: importedLikes.tracks.map(toTrackView), nextCursor: importedLikes.nextCursor }}
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
