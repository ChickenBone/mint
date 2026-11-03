import Link from "next/link";
import { LinkYoutubeCallout } from "@/components/app/link-youtube";
import { LiveTrackList } from "@/components/app/live-track-list";
import { firstCover, PageHeader } from "@/components/app/page-header";
import { SyncPanel } from "@/components/app/sync-panel";
import { FreshShelf } from "@/components/fresh-shelf";
import { requireUser } from "@/lib/auth";
import { getLikedTracks, getRecentlyReady, getUserJobs, getUserSummary, getYoutubeAccount, syncStateOf } from "@/lib/data";
import { formatCount, formatHours } from "@/lib/format";

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export default async function Home() {
  const user = await requireUser();
  const [acct, summary, liked, jobs, fresh] = await Promise.all([
    getYoutubeAccount(user.id),
    getUserSummary(user.id),
    getLikedTracks(user.id),
    getUserJobs(user.id),
    getRecentlyReady(12),
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
              {formatHours(summary.durationSec)} in Plexamp
              {summary.active > 0 && <> · <Link href="/app/jobs" className="text-mint hover:underline">{formatCount(summary.active)} on the way</Link></>}
              {summary.failed > 0 && <> · <Link href="/app/jobs" className="text-danger hover:underline">{formatCount(summary.failed)} failed</Link></>}
            </p>
          ) : (
            "Your account is ready. One step left."
          )
        }
      >
        {acct && <SyncPanel initial={syncStateOf(acct)} />}
      </PageHeader>

      {!acct && <LinkYoutubeCallout />}

      {acct && jobs.length > 0 && (
        <section className="mt-4">
          <div className="mb-3 flex items-end justify-between">
            <h2 className="text-3xl font-extrabold tracking-[-0.025em]">On the way</h2>
            <Link href="/app/jobs" className="text-sm font-semibold text-muted hover:text-fg">All jobs</Link>
          </div>
          <LiveTrackList initial={jobs.slice(0, 6)} mode="jobs" />
        </section>
      )}

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
    </>
  );
}
