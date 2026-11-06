import Link from "next/link";
import { FreshShelf } from "@/components/fresh-shelf";
import { requireUser } from "@/lib/auth";
import { getLikedTracks, getRecentlyReady, getUserSummary, getYoutubeAccount } from "@/lib/data";
import { getDb, schema } from "@mint/core/db";
import { spotifyAccountView } from "@mint/core/spotify-store";
import { toTrackView } from "@mint/core/views";
import { discoverMusic } from "@/lib/music-discovery";
import { RecommendationShelf } from "@/components/app/recommendation-shelf";
import { ListeningSpotlight } from "@/components/app/listening-spotlight";
import { MusicTrackList } from "@/components/app/music-track-list";
import { SetupNudge } from "@/components/app/setup-nudge";
import { musicHistory } from "@mint/core/music-db";
import { artistPlayerId } from "@/lib/player-protocol";
import { Artwork } from "@/components/artwork";
import { desc, eq } from "drizzle-orm";

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export default async function Home() {
  const user = await requireUser();
  const db = getDb();
  const [acct, spAccount, summary, liked, fresh, recommendations, historyRows] = await Promise.all([
    getYoutubeAccount(user.id),
    spotifyAccountView(db, user.id),
    getUserSummary(user.id),
    getLikedTracks(user.id, 12),
    getRecentlyReady(12),
    discoverMusic(db, user.id, "for-you", [], 12),
    db
      .select({ track: schema.tracks })
      .from(musicHistory)
      .innerJoin(schema.tracks, eq(musicHistory.trackId, schema.tracks.id))
      .where(eq(musicHistory.userId, user.id))
      .orderBy(desc(musicHistory.createdAt), desc(musicHistory.id))
      .limit(60),
  ]);
  const yourRecent = liked.filter((t) => t.stage === "ready" || t.stage === "analyzing").slice(0, 12);
  const continueListening = [
    ...new Map(
      historyRows
        .filter(({ track }) => track.stage === "ready" || track.stage === "analyzing")
        .map(({ track }) => [track.id, track]),
    ).values(),
  ]
    .slice(0, 8)
    .map(toTrackView);
  const isLinked = Boolean(acct || spAccount);
  const likedArtists = [...new Map(liked.map((track) => [track.artist, track])).values()].slice(0, 8);

  return (
    <>
      <h1 className="mb-6 text-xl font-semibold tracking-tight">
        {greeting()}, {user.name.split(" ")[0]}.
      </h1>
      <ListeningSpotlight
        track={recommendations.items[0] ? toTrackView(recommendations.items[0].track) : fresh[0] ?? null}
        reason={recommendations.items[0]?.reason}
      />

      <SetupNudge linked={isLinked} summary={summary} />

      <section className="mt-8" aria-labelledby="continue-listening">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
          <h2 id="continue-listening" className="text-2xl font-bold tracking-tight">
            Continue listening
          </h2>
          {continueListening.length > 0 && (
            <Link href="/app/collection?tab=history" className="inline-flex min-h-11 items-center text-sm font-semibold text-muted hover:text-fg">
              Full history
            </Link>
          )}
        </div>
        {continueListening.length ? (
          <MusicTrackList entries={continueListening.map((track) => ({ key: track.id, track }))} />
        ) : (
          <div className="rounded-xl border border-line/60 bg-elevated/40 p-5">
            <p className="max-w-prose text-sm text-muted">
              Your recently played songs will show up here once you start listening.
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              <Link
                href="/app/library"
                className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-xs font-semibold text-fg hover:bg-hover"
              >
                Browse library
              </Link>
              {!isLinked && (
                <Link
                  href="/app/settings?section=services"
                  className="inline-flex min-h-11 items-center rounded-full bg-mint px-4 text-xs font-bold text-mint-ink hover:bg-mint-strong"
                >
                  Connect a service
                </Link>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="mt-10">
        <div className="mb-3 flex items-end justify-between gap-4">
          <h2 className="text-3xl font-extrabold tracking-[-0.025em]">Made for you</h2>
          <Link href="/app/discover" className="inline-flex min-h-11 items-center text-sm font-semibold text-muted hover:text-fg">
            Explore mixes
          </Link>
        </div>
        <p className="mb-5 max-w-prose text-sm leading-relaxed text-muted">{recommendations.explanation}</p>
        <RecommendationShelf items={recommendations.items.slice(0, 6).map(({ track, reason }) => ({ track: toTrackView(track), reason }))} />
      </section>

      {likedArtists.length > 0 && (
        <section className="mt-10" aria-labelledby="liked-artists">
          <div className="mb-4 flex items-end justify-between gap-3">
            <div>
              <h2 id="liked-artists" className="text-2xl font-bold tracking-tight">Artists from your likes</h2>
              <p className="mt-1 text-sm text-muted">Real artist artwork from Plex when it is available.</p>
            </div>
            <Link href="/app/collection?tab=likes" className="inline-flex min-h-11 items-center text-sm font-semibold text-muted hover:text-fg">Your likes</Link>
          </div>
          <ul className="flex gap-5 overflow-x-auto pb-3" aria-label="Artists from your YouTube Music likes">
            {likedArtists.map((track) => (
              <li key={track.artist} className="w-24 shrink-0 text-center">
                <Link href={`/app/library/artists/${encodeURIComponent(artistPlayerId(track.artist))}?type=album`}
                  className="group inline-flex min-h-11 flex-col items-center gap-2 rounded-md p-1 text-sm font-semibold hover:text-fg">
                  <Artwork track={{ artworkUrl: `/api/artwork/${track.id}?variant=artist` }} className="size-20 rounded-full" />
                  <span className="max-w-full truncate group-hover:underline">{track.artist}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(summary.active > 0 || summary.failed > 0) && (
        <section className="my-10 flex flex-wrap items-center justify-between gap-4 border-y border-line py-5" aria-label="Music backlog progress">
          <div>
            <h2 className="text-xl font-bold">{summary.active > 0 ? "Your music is on the way" : "Some music needs attention"}</h2>
            <p className="mt-1 text-sm text-muted">{[
              summary.active > 0 ? `${summary.active.toLocaleString()} ${summary.active === 1 ? "song is" : "songs are"} in progress` : "",
              summary.failed > 0 ? `${summary.failed.toLocaleString()} need attention` : "",
            ].filter(Boolean).join(" · ")}.</p>
          </div>
          <Link href="/app/collection?tab=requests" className="inline-flex min-h-11 items-center rounded-full bg-elevated px-5 text-sm font-semibold hover:bg-hover">
            Review requests
          </Link>
        </section>
      )}

      <Link href="/app/discover/charts" className="my-12 flex flex-wrap items-center justify-between gap-5 border-y border-line py-7">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Beyond your usual rotation.</h2>
          <p className="mt-2 max-w-prose text-sm text-muted">
            Country Top 50s, worldwide communities and independent discoveries.
          </p>
        </div>
        <span className="inline-flex min-h-11 items-center rounded-full px-5 text-sm font-semibold ring-1 ring-line">
          Explore the charts →
        </span>
      </Link>

      {yourRecent.length > 0 && (
        <section className="mt-10">
          <div className="mb-3 flex items-end justify-between">
            <h2 className="text-3xl font-extrabold tracking-[-0.025em]">Your recent likes</h2>
            <Link href="/app/collection?tab=likes" className="inline-flex min-h-11 items-center text-sm font-semibold text-muted hover:text-fg">
              Show all
            </Link>
          </div>
          <FreshShelf initial={yourRecent} liveAdd={false} />
        </section>
      )}

      <section className="mt-10">
        <h2 className="mb-3 text-3xl font-extrabold tracking-[-0.025em]">New arrivals</h2>
        {fresh.length > 0 ? (
          <FreshShelf initial={fresh} feature={false} />
        ) : (
          <div className="rounded-xl border border-line/60 bg-elevated/40 p-5">
            <p className="max-w-prose text-sm text-muted">
              No songs have landed in the library yet. Connect YouTube Music in Settings to start bringing in your music.
            </p>
            <Link
              href="/app/settings?section=services"
              className="mt-3 inline-flex min-h-11 items-center rounded-full bg-mint px-4 text-xs font-bold text-mint-ink hover:bg-mint-strong"
            >
              Connect a service
            </Link>
          </div>
        )}
      </section>
    </>
  );
}
