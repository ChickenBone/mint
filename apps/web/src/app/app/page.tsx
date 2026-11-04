import Link from "next/link";
import { LinkYoutubeCallout } from "@/components/app/link-youtube";
import { FreshShelf } from "@/components/fresh-shelf";
import { requireUser } from "@/lib/auth";
import { getLikedTracks, getRecentlyReady, getUserSummary, getYoutubeAccount } from "@/lib/data";
import { getDb } from "@mint/core/db";
import { toTrackView } from "@mint/core/views";
import { discoverMusic } from "@/lib/music-discovery";
import { RecommendationShelf } from "@/components/app/recommendation-shelf";
import { ListeningSpotlight } from "@/components/app/listening-spotlight";

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export default async function Home() {
  const user = await requireUser();
  const [acct, summary, liked, fresh, recommendations] = await Promise.all([
    getYoutubeAccount(user.id),
    getUserSummary(user.id),
    getLikedTracks(user.id, 12),
    getRecentlyReady(12),
    discoverMusic(getDb(), user.id, "for-you", [], 12),
  ]);
  const yourRecent = liked.filter((t) => t.stage === "ready" || t.stage === "analyzing").slice(0, 12);

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{greeting()}, {user.name.split(" ")[0]}.</h1>
        {(summary.active > 0 || summary.failed > 0) && <Link href="/app/jobs" className={`inline-flex min-h-11 items-center gap-2 text-xs ${summary.failed ? "text-warn" : "text-muted"}`}>
          <span className={`size-1.5 rounded-full ${summary.failed ? "bg-warn" : "bg-mint"}`} />{summary.failed ? `${summary.failed} requests need attention` : `${summary.active} songs on the way`}</Link>}
      </div>
      <ListeningSpotlight track={recommendations.items[0] ? toTrackView(recommendations.items[0].track) : fresh[0] ?? null} reason={recommendations.items[0]?.reason} />

      <section>
        <div className="mb-3 flex items-end justify-between gap-4"><h2 className="text-3xl font-extrabold tracking-[-0.025em]">Made for your next listen</h2>
          <Link href="/app/discover" className="text-sm font-semibold text-muted hover:text-fg">Explore mixes</Link></div>
        <p className="mb-5 max-w-2xl text-sm leading-relaxed text-muted">{recommendations.explanation}</p>
        <RecommendationShelf items={recommendations.items.slice(0, 6).map(({ track, reason }) => ({ track: toTrackView(track), reason }))} />
      </section>

      <Link href="/app/discover?tab=charts" className="my-12 flex flex-wrap items-center justify-between gap-5 border-y border-line py-7">
        <div><h2 className="text-2xl font-bold tracking-tight">Beyond your usual rotation.</h2><p className="mt-2 text-sm text-muted">Country Top 50s, worldwide communities and independent discoveries.</p></div><span className="inline-flex min-h-11 items-center rounded-full px-5 text-sm font-semibold ring-1 ring-line">Explore the charts →</span>
      </Link>
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
      {!acct && <div className="mt-10"><LinkYoutubeCallout /><Link href="/app/spotify" className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-mint hover:underline">Or bring your Spotify playlists</Link></div>}
    </>
  );
}
