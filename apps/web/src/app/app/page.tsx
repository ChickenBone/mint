import Link from "next/link";
import type { TrackView } from "@mint/core/events";
import { getDb, schema } from "@mint/core/db";
import { musicHistory, musicLikes } from "@mint/core/music-db";
import { toTrackView } from "@mint/core/views";
import { desc, eq } from "drizzle-orm";
import { TrackCard } from "@/components/track-list";
import { FreshShelf } from "@/components/fresh-shelf";
import { Shelf } from "@/components/ui/shelf";
import { requireUser } from "@/lib/auth";
import { getRecentlyReady } from "@/lib/data";
import { discoverMusic } from "@/lib/music-discovery";

function greeting() {
  const hour = new Date().getHours();
  return hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

function SongShelf({ title, tracks, href, linkLabel }: {
  title: string;
  tracks: TrackView[];
  href?: string;
  linkLabel?: string;
}) {
  if (!tracks.length) return null;
  return (
    <section className="mt-10">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="text-2xl font-bold tracking-tight">{title}</h2>
        {href && <Link href={href} className="inline-flex min-h-11 items-center text-sm font-semibold text-muted hover:text-fg">
          {linkLabel ?? "Show all"}
        </Link>}
      </div>
      <Shelf label={title}>
        {tracks.map((track) => <li key={track.id}><TrackCard track={track} /></li>)}
      </Shelf>
    </section>
  );
}

export default async function Home() {
  const user = await requireUser();
  const db = getDb();
  const [likedRows, fresh, recommendations, historyRows] = await Promise.all([
    db.select({ track: schema.tracks })
      .from(musicLikes)
      .innerJoin(schema.tracks, eq(musicLikes.trackId, schema.tracks.id))
      .where(eq(musicLikes.userId, user.id))
      .orderBy(desc(musicLikes.createdAt), desc(musicLikes.trackId))
      .limit(12),
    getRecentlyReady(12),
    discoverMusic(db, user.id, "for-you", [], 12),
    db.select({ track: schema.tracks })
      .from(musicHistory)
      .innerJoin(schema.tracks, eq(musicHistory.trackId, schema.tracks.id))
      .where(eq(musicHistory.userId, user.id))
      .orderBy(desc(musicHistory.createdAt), desc(musicHistory.id))
      .limit(60),
  ]);
  const playable = (track: TrackView) => track.stage === "ready" || track.stage === "analyzing";
  const recentlyPlayed = [...new Map(
    historyRows.filter(({ track }) => track.stage === "ready" || track.stage === "analyzing")
      .map(({ track }) => [track.id, track]),
  ).values()].slice(0, 12).map(toTrackView);
  const liked = likedRows.map(({ track }) => toTrackView(track)).filter(playable);
  const recommended = recommendations.items.map(({ track }) => toTrackView(track)).filter(playable);
  const newArrivals = fresh.filter(playable);

  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{greeting()}</h1>
      <nav aria-label="Browse music" className="mt-6 flex flex-wrap gap-2">
        <Link href="/app/library" className="inline-flex min-h-11 items-center rounded-full bg-elevated px-5 text-sm font-semibold hover:bg-hover">
          Browse all music
        </Link>
        <Link href="/app/discover" className="inline-flex min-h-11 items-center rounded-full bg-elevated px-5 text-sm font-semibold hover:bg-hover">
          Discover
        </Link>
        <Link href="/app/collection?tab=likes" className="inline-flex min-h-11 items-center rounded-full bg-elevated px-5 text-sm font-semibold hover:bg-hover">
          Liked songs
        </Link>
      </nav>

      <SongShelf title="Recently played" tracks={recentlyPlayed} href="/app/collection?tab=history" />
      <SongShelf title="Recommended for you" tracks={recommended} href="/app/discover" linkLabel="Explore" />
      {newArrivals.length > 0 && (
        <section className="mt-10">
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2 className="text-2xl font-bold tracking-tight">Recently added</h2>
            <Link href="/app/library" className="inline-flex min-h-11 items-center text-sm font-semibold text-muted hover:text-fg">
              Show all
            </Link>
          </div>
          <div role="region" aria-label="Recently added" tabIndex={0}
            className="overflow-x-auto overscroll-x-contain pb-3 scrollbar-thin">
            <FreshShelf initial={newArrivals} feature={false}
              className="grid-cols-none! grid-flow-col! auto-cols-[min(44vw,14rem)]" />
          </div>
        </section>
      )}
      <SongShelf title="Liked songs" tracks={liked} href="/app/collection?tab=likes" />

      {!recentlyPlayed.length && !recommended.length && !newArrivals.length && !liked.length && (
        <section className="mt-12 max-w-lg" aria-labelledby="home-empty">
          <h2 id="home-empty" className="text-2xl font-bold">Find something to play</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Search for music or explore the library. Your recent listens and recommendations will appear here.
          </p>
          <Link href="/app/search" className="mt-5 inline-flex min-h-11 items-center rounded-full bg-mint px-5 text-sm font-bold text-mint-ink hover:bg-mint-strong">
            Search
          </Link>
        </section>
      )}
    </>
  );
}
