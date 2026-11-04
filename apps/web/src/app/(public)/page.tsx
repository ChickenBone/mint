import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { ArtWall } from "@/components/art-wall";
import { FreshShelf } from "@/components/fresh-shelf";
import { LiveStats } from "@/components/live-stats";
import { PipelineBoard } from "@/components/pipeline-board";
import { getActiveTracks, getLibraryArtwork, getRecentlyReady, getStats } from "@/lib/data";

export const dynamic = "force-dynamic";

const steps: Array<[string, string]> = [
  ["Link YouTube Music", "Sign in with Google once. Mint reads your likes and the playlists you choose. It never posts, rates or changes anything."],
  ["Find the real release", "Each song is matched against MusicBrainz and requested through Lidarr, which grabs the album over TorBox. If no release turns up, Mint rips the audio from YouTube instead."],
  ["Tag, file, scan", "Files are tagged with artwork and moved into the shared Plex library. Mint measures the audio for its own Smart Fades, loudness controls and discovery."],
  ["Play it in Mint", "Listen in Mint with your likes, playlists and recommendations together. Plex stays behind the scenes as the library server; no embedded player or separate music app is needed."],
];

export default async function Home() {
  const [stats, active, fresh, wall] = await Promise.all([getStats(), getActiveTracks(120), getRecentlyReady(12), getLibraryArtwork()]);
  return (
    <>
      <section className="relative isolate overflow-hidden">
        <ArtWall tracks={wall} />
        <div className="relative mx-auto flex min-h-[min(46rem,88svh)] max-w-7xl flex-col justify-end px-5 pt-28 pb-16 sm:px-8 sm:pb-24">
          <h1 className="rise max-w-5xl text-[clamp(2.75rem,9vw,7.5rem)] leading-[0.92] font-extrabold tracking-[-0.045em]">
            Every song you like, on a shelf we&nbsp;own.
          </h1>
          <p className="rise mt-8 max-w-xl text-lg text-muted sm:text-xl" style={{ "--rise-delay": "120ms" } as React.CSSProperties}>
            Mint watches your YouTube Music likes, downloads each song to our server and serves it through Plexamp. Every cover on this page is
            already here.
          </p>
          <div className="rise mt-10 flex flex-wrap items-center gap-3" style={{ "--rise-delay": "220ms" } as React.CSSProperties}>
            <Link
              href="/request-access"
              className="inline-flex items-center gap-2 rounded-full bg-mint px-7 py-3.5 text-lg font-semibold text-mint-ink transition duration-300 ease-out-expo hover:scale-[1.03] hover:bg-mint-strong"
            >
              Request access <ArrowRight className="size-5" aria-hidden />
            </Link>
            <Link
              href="/browse"
              className="rounded-full bg-bg/60 px-7 py-3.5 text-lg font-semibold text-fg ring-1 ring-line backdrop-blur-sm transition hover:bg-elevated hover:ring-faint"
            >
              Browse the library
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-5 pt-8 pb-28 sm:px-8" aria-labelledby="stats-h">
        <h2 id="stats-h" className="sr-only">The library right now</h2>
        <LiveStats initial={stats} />
      </section>

      <section className="mx-auto max-w-7xl px-5 pb-28 sm:px-8" aria-labelledby="fresh-h">
        <div className="mb-8 flex items-end justify-between gap-4">
          <div>
            <h2 id="fresh-h" className="text-4xl font-extrabold tracking-[-0.03em] sm:text-6xl">Just landed</h2>
            <p className="mt-3 max-w-xl text-muted">The newest songs in the library. New arrivals drop in here the moment Plex picks them up.</p>
          </div>
          <Link href="/browse" className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-muted hover:text-fg">
            Show all <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>
        <FreshShelf initial={fresh} />
      </section>

      <section id="pipeline" className="mx-auto max-w-7xl scroll-mt-20 px-5 pb-28 sm:px-8" aria-labelledby="pipeline-h">
        <div className="mb-8 max-w-2xl">
          <h2 id="pipeline-h" className="text-4xl font-extrabold tracking-[-0.03em] sm:text-6xl">On the way in</h2>
          <p className="mt-3 text-muted">Every song members have liked that&rsquo;s still being fetched, imported, scanned or analysed. This board updates as it happens.</p>
        </div>
        <PipelineBoard initialTracks={active} initialStats={stats} />
      </section>

      <section id="how" className="mx-auto max-w-7xl scroll-mt-20 px-5 pb-28 sm:px-8" aria-labelledby="how-h">
        <h2 id="how-h" className="max-w-3xl text-4xl font-extrabold tracking-[-0.03em] sm:text-6xl">How a like becomes a file</h2>
        <ol className="mt-14">
          {steps.map(([title, body], i) => (
            <li key={title} className="grid gap-x-10 gap-y-3 border-t border-line py-8 sm:grid-cols-[6rem_minmax(0,1fr)_minmax(0,1.2fr)] sm:py-10">
              <span className="text-5xl leading-none font-extrabold tracking-tight text-faint tabular sm:text-6xl" aria-hidden>
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h3>
              <p className="max-w-prose text-lg text-muted">{body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="relative isolate overflow-hidden border-t border-line" aria-labelledby="invite-h">
        <div className="mx-auto flex max-w-7xl flex-col items-start gap-8 px-5 py-24 sm:px-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <h2 id="invite-h" className="text-5xl leading-[0.95] font-extrabold tracking-[-0.04em] sm:text-7xl">Mint is invite-only.</h2>
            <p className="mt-5 max-w-xl text-lg text-muted">Ask for a seat. Once the admin approves you, link YouTube Music and your likes start arriving.</p>
          </div>
          <Link
            href="/request-access"
            className="inline-flex shrink-0 items-center gap-2 rounded-full bg-mint px-8 py-4 text-lg font-semibold text-mint-ink transition duration-300 ease-out-expo hover:scale-[1.03] hover:bg-mint-strong"
          >
            Request access <ArrowRight className="size-5" aria-hidden />
          </Link>
        </div>
      </section>
    </>
  );
}
