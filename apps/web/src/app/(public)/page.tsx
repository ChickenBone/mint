import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { FreshShelf } from "@/components/fresh-shelf";
import { LiveStats } from "@/components/live-stats";
import { PipelineBoard } from "@/components/pipeline-board";
import { getActiveTracks, getRecentlyReady, getStats } from "@/lib/data";

export const dynamic = "force-dynamic";

const steps: Array<[string, string]> = [
  ["Link YouTube Music", "Sign in with Google once. Mint reads your likes and the playlists you choose. It never posts, rates or changes anything."],
  ["Mint finds the real release", "Each song is matched against MusicBrainz and requested through Lidarr, which grabs the album over TorBox. If no release turns up, Mint rips the audio from YouTube instead."],
  ["Tagged, filed, scanned", "Files are tagged with artwork and moved into the shared library. Plex scans them in and runs sonic analysis so Sonic Radio and Sweet Fades just work."],
  ["Play it in Plexamp", "Your likes and synced playlists appear as Plex playlists under your name. Like a song on YouTube and it lands in Plexamp minutes later."],
];

export default async function Home() {
  const [stats, active, fresh] = await Promise.all([getStats(), getActiveTracks(120), getRecentlyReady(12)]);
  return (
    <>
      <section className="relative overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(60rem_30rem_at_15%_-10%,color-mix(in_oklab,var(--color-mint)_22%,transparent),transparent_70%)]"
          aria-hidden
        />
        <div className="relative mx-auto max-w-7xl px-5 pt-20 pb-16 sm:px-8 sm:pt-28">
          <h1 className="max-w-4xl text-5xl font-extrabold tracking-[-0.035em] sm:text-7xl">Every song you like, on a shelf we own.</h1>
          <p className="mt-6 max-w-2xl text-lg text-muted sm:text-xl">
            Mint watches your YouTube Music likes, downloads each song to our server and serves it through Plexamp. Watch the library grow live and
            preview anything on it.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-3">
            <Link
              href="/request-access"
              className="inline-flex items-center gap-2 rounded-full bg-mint px-6 py-3 font-semibold text-mint-ink transition hover:scale-[1.03] hover:bg-mint-strong"
            >
              Request access <ArrowRight className="size-4" aria-hidden />
            </Link>
            <Link href="/browse" className="rounded-full px-6 py-3 font-semibold text-fg ring-1 ring-line transition hover:bg-elevated hover:ring-faint">
              Browse the library
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-5 pb-20 sm:px-8" aria-labelledby="stats-h">
        <h2 id="stats-h" className="sr-only">Library stats</h2>
        <LiveStats initial={stats} />
      </section>

      <section id="pipeline" className="mx-auto max-w-7xl scroll-mt-20 px-5 pb-20 sm:px-8">
        <div className="mb-6 max-w-2xl">
          <h2 className="text-3xl font-bold tracking-tight">On the way in</h2>
          <p className="mt-2 text-muted">Every song members have liked that&rsquo;s still being fetched, imported, scanned or analysed. This board updates as it happens.</p>
        </div>
        <PipelineBoard initialTracks={active} initialStats={stats} />
      </section>

      <section className="mx-auto max-w-7xl px-5 pb-20 sm:px-8">
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">Just landed</h2>
            <p className="mt-2 text-muted">Hover a cover and press play for the first 30 seconds.</p>
          </div>
          <Link href="/browse" className="shrink-0 text-sm font-semibold text-muted hover:text-fg">
            Show all
          </Link>
        </div>
        <FreshShelf initial={fresh} />
      </section>

      <section id="how" className="mx-auto max-w-7xl scroll-mt-20 px-5 pb-24 sm:px-8">
        <h2 className="text-3xl font-bold tracking-tight">How a like becomes a file</h2>
        <ol className="mt-10 grid gap-x-12 gap-y-10 md:grid-cols-2">
          {steps.map(([title, body], i) => (
            <li key={title} className="flex gap-5">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-elevated text-sm font-bold text-mint tabular" aria-hidden>
                {i + 1}
              </span>
              <div>
                <h3 className="text-lg font-semibold">{title}</h3>
                <p className="mt-1.5 max-w-prose text-muted">{body}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-16 flex flex-col items-start gap-5 rounded-2xl bg-elevated p-8 sm:flex-row sm:items-center sm:justify-between sm:p-10">
          <div>
            <p className="text-2xl font-bold tracking-tight">Mint is invite-only.</p>
            <p className="mt-1 text-muted">Ask for a seat. Once the admin approves you, link YouTube Music and your likes start arriving.</p>
          </div>
          <Link href="/request-access" className="shrink-0 rounded-full bg-mint px-6 py-3 font-semibold text-mint-ink transition hover:scale-[1.03] hover:bg-mint-strong">
            Request access
          </Link>
        </div>
      </section>
    </>
  );
}
