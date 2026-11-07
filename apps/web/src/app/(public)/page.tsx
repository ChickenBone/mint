import type { Metadata } from "next";
import Link from "next/link";
import { ArrowDownRight, ArrowRight } from "lucide-react";
import { Artwork } from "@/components/artwork";
import { MintMark } from "@/components/logo";
import { getLibraryArtwork, getRecentlyReady } from "@/lib/data";
import { getUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Your music, with room to wander",
  description:
    "Explore a shared music library, build personal playlists, and listen in Mint’s own player. Browse the public catalog or request access.",
};

export const dynamic = "force-dynamic";

export default async function Home() {
  const [user, recentResult, artworkResult] = await Promise.all([
    getUser(),
    getRecentlyReady(4).then(
      (tracks) => ({ status: "fulfilled" as const, tracks }),
      () => ({ status: "rejected" as const }),
    ),
    getLibraryArtwork().then(
      (artwork) => ({ status: "fulfilled" as const, artwork }),
      () => ({ status: "rejected" as const }),
    ),
  ]);
  const recent = recentResult.status === "fulfilled" ? recentResult.tracks : [];
  const artwork = artworkResult.status === "fulfilled" ? artworkResult.artwork.slice(0, 4) : [];
  const directionContract = `<!--
THESIS: An intimate listening room for a shared library and personal collections, not a feature-grid pitch.
OWN-WORLD: Charcoal, Figtree, mint action, square real-library sleeves, and a restrained teal-blue atmosphere.
STORY: Find music in the shared library, make it yours with playlists, then request access or sign in.
FIRST VIEWPORT: Browse navigation above a left-aligned promise and actions; a responsive public-artwork gallery balances the right.
FORM: Third of seven grounded structures: an artwork-led editorial page, compact recent arrivals, and a shared-library/personal-collection split that comes together in Mint. Seed bfe43ff0; parallel-streams staging.
-->`;

  return (
    <>
      <noscript
        dangerouslySetInnerHTML={{
          __html: directionContract,
        }}
      />
      <section className="marketing-hero" aria-labelledby="marketing-title">
        <div className="marketing-hero-copy">
          <h1 id="marketing-title">
            Your music,
            <br className="hidden sm:block" /> with room to wander.
          </h1>
          <p>
            Explore a shared library, build playlists around what you love, and listen in Mint’s
            own player.
          </p>
          <div className="marketing-actions">
            <Link
              href={user ? "/app" : "/request-access"}
              className="marketing-primary"
            >
              {user ? "Open your music" : "Request access"}
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
            {!user && (
              <Link href="/login" className="marketing-signin">
                Sign in
                <ArrowDownRight aria-hidden="true" className="size-4" />
              </Link>
            )}
          </div>
        </div>

        <div
          className="marketing-artwork"
          aria-hidden="true"
          data-artwork={artwork.length ? "present" : "empty"}
        >
          <div className="marketing-art-glow" />
          {artwork.length ? (
            artwork.map((cover, index) => (
              <div
                className={`marketing-cover marketing-cover-${index + 1}`}
                key={`${cover.artworkUrl}-${index}`}
              >
                <Artwork track={cover} eager />
              </div>
            ))
          ) : (
            <div className="marketing-empty-art">
              <div className="marketing-record">
                <div className="marketing-record-label">
                  <MintMark className="size-10" />
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="marketing-story" aria-labelledby="marketing-story-title">
        <div className="marketing-story-lead">
          <h2 id="marketing-story-title">
            A shared library.
            <br />A listening life of your own.
          </h2>
          <p>
            Find something familiar, follow a new thread, and keep the music you love close.
          </p>
        </div>
        <div className="marketing-story-pair">
          <article>
            <h3>Start with the shared library.</h3>
            <p>
              Browse albums, artists, and songs, then explore more of what’s in the collection.
            </p>
          </article>
          <article>
            <h3>Make it yours.</h3>
            <p>
              Like songs, build personal playlists, and listen in Mint’s own browser player.
            </p>
          </article>
        </div>
      </section>

      <section className="marketing-recent" aria-labelledby="marketing-recent-title">
        {recentResult.status === "rejected" ? (
          <div className="marketing-recent-unavailable" role="status">
            <div>
              <h2 id="marketing-recent-title">Recent additions</h2>
              <p>They aren’t available right now. You can still browse the shared library.</p>
            </div>
            <Link href="/browse" className="marketing-text-link">
              Browse library <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
          </div>
        ) : recent.length > 0 ? (
          <>
            <div className="marketing-recent-heading">
              <div>
                <h2 id="marketing-recent-title">Recently added</h2>
                <p>A small glimpse of what’s in the shared library.</p>
              </div>
              <Link href="/activity" className="marketing-text-link">
                Library activity <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
            </div>
            <ul className="marketing-recent-list">
              {recent.map((track) => (
                <li className="marketing-recent-item" key={track.id}>
                  <Artwork track={track} />
                  <div className="marketing-recent-copy">
                    <p>{track.title}</p>
                    <span>{track.artist}</span>
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      <section className="marketing-close" aria-labelledby="marketing-close-title">
        <h2 id="marketing-close-title">There’s always more to discover.</h2>
        <Link href={user ? "/app" : "/request-access"} className="marketing-close-link">
          {user ? "Open Mint" : "Find your way in"}
          <ArrowRight aria-hidden="true" className="size-4" />
        </Link>
      </section>
    </>
  );
}
