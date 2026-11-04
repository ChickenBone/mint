import { getDb, schema } from "@mint/core/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { musicHistory } from "@mint/core/music-db";
import { toTrackView } from "@mint/core/views";
import { requireUser } from "@/lib/auth";
import { musicProfile } from "@/lib/music-store";
import { ListeningHistory } from "@/components/app/listening-history";

export default async function HistoryPage() {
  const user = await requireUser(), db = getDb(), profile = await musicProfile(db, user.id);
  const [rows, excluded] = await Promise.all([
    db.select({ event: musicHistory, track: schema.tracks }).from(musicHistory).innerJoin(schema.tracks, eq(schema.tracks.id, musicHistory.trackId))
      .where(and(eq(musicHistory.userId, user.id))).orderBy(desc(musicHistory.createdAt), desc(musicHistory.id)).limit(101),
    profile.exclusions.length ? db.select().from(schema.tracks).where(inArray(schema.tracks.id, profile.exclusions)) : Promise.resolve([]),
  ]);
  return <ListeningHistory initialEntries={rows.map((r) => ({ ...r, event: { ...r.event, createdAt: r.event.createdAt.toISOString() }, track: toTrackView(r.track) }))}
    initialPrivate={profile.privateSession} initialExcluded={excluded.map(toTrackView)} />;
}
