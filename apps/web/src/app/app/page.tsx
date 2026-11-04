import Link from "next/link";
import { LinkYoutubeCallout } from "@/components/app/link-youtube";
import { LiveTrackList } from "@/components/app/live-track-list";
import { firstCover, PageHeader } from "@/components/app/page-header";
import { SyncPanel } from "@/components/app/sync-panel";
import { FreshShelf } from "@/components/fresh-shelf";
import { requireUser } from "@/lib/auth";
import { getLikedTracks, getRecentlyReady, getUserJobs, getUserSummary, getYoutubeAccount, syncStateOf } from "@/lib/data";
import { formatCount, formatHours } from "@/lib/format";
import { getDb } from "@mint/core/db";
import { toTrackView } from "@mint/core/views";
import { discoverMusic } from "@/lib/music-discovery";
import { RecommendationShelf } from "@/components/app/recommendation-shelf";

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export default async function Home() {
  const user = await requireUser();
  const [acct, summary, liked, jobs, fresh, recommendations] = await Promise.all([
    getYoutubeAccount(user.id),
    getUserSummary(user.id),
    getLikedTracks(user.id, 12),
    getUserJobs(user.id, { limit: 6 }),
    getRecentlyReady(12),
    discoverMusic(getDb(), user.id, "for-you", [], 12),
  ]);
  const yourRecent = liked.filter((t) => t.stage === "ready" || t.stage === "analyzing").slice(0, 12);

  return (
    <>
      <PageHeader
        title={`${greeting()}, ${user.name.split(" ")[0]}`}
        backdrop={firstCover(yourRecent) ?? firstCover(fresh)}
        sub={
          acct ? (
            <p className="tabular">
              <span className="text-fg">{formatCount(summary.ready)}</span> of your {formatCount(summary.total)} songs are ready ·{" "}
              {formatHours(summary.durationSec)} in your library
              {summary.active > 0 && <> · <Link href="/app/jobs" className="text-mint hover:underline">{formatCount(summary.active)} on the way</Link></>}
              {summary.failed > 0 && <> · <Link href="/app/jobs" className="text-danger hover:underline">{formatCount(summary.failed)} failed</Link></>}
            </p>
          ) : (
            "A new corner of your music, every day."
          )
        }
      >
        {acct && <SyncPanel initial={syncStateOf(acct)} />}
      </PageHeader>

      <form action="/app/music" className="mb-10 flex max-w-2xl gap-2">
        <input type="hidden" name="view" value="search" /><input type="hidden" name="type" value="track" />
        <label className="min-w-0 flex-1"><span className="sr-only">Search your music backlog</span>
          <input required name="q" maxLength={100} type="search" placeholder="A song, an artist, a few words…" className="min-h-12 w-full rounded-full bg-elevated px-5 text-sm outline-none focus:ring-2 focus:ring-mint" /></label>
        <button className="min-h-12 rounded-full bg-fg px-5 text-sm font-semibold text-bg">Search</button>
      </form>

      <section>
        <div className="mb-3 flex items-end justify-between gap-4"><h2 className="text-3xl font-extrabold tracking-[-0.025em]">Made for your next listen</h2>
          <Link href="/app/discover" className="text-sm font-semibold text-muted hover:text-fg">Explore mixes</Link></div>
        <p className="mb-5 max-w-2xl text-sm leading-relaxed text-muted">{recommendations.explanation}</p>
        <RecommendationShelf items={recommendations.items.map(({ track, reason }) => ({ track: toTrackView(track), reason }))} />
      </section>

      {yourRecent.length > 0 && (
        <section className="mt-10">
          <div className="mb-3 flex items-end justify-between">
            <h2 className="text-3xl font-extrabold tracking-[-0.025em]">Your recent likes</h2>
            <Link href="/app/liked" className="text-sm font-semibold text-muted hover:text-fg">Show all</Link>
          </div>
          <FreshShelf initial={yourRecent} liveAdd={false} />
        </section>
      )}

      <section className="mt-10">
        <h2 className="mb-3 text-3xl font-extrabold tracking-[-0.025em]">New on the server</h2>
        <FreshShelf initial={fresh} feature={false} />
      </section>
      {jobs.length > 0 && <section className="mt-10 border-t border-line pt-7">
        <div className="mb-3 flex items-end justify-between"><h2 className="text-2xl font-bold">On the way</h2><Link href="/app/jobs" className="text-sm font-semibold text-muted hover:text-fg">All jobs</Link></div>
        <LiveTrackList initial={jobs} mode="jobs" />
      </section>}
      {!acct && <div className="mt-10"><LinkYoutubeCallout /><Link href="/app/spotify" className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-mint hover:underline">Or bring your Spotify playlists</Link></div>}
    </>
  );
}
