import type { Metadata } from "next";
import { LibraryBrowser } from "@/components/library-browser";
import { getStats, searchLibrary } from "@/lib/data";
import { formatCount } from "@/lib/format";

export const metadata: Metadata = { title: "Browse", description: "Search every song in the Mint library." };
export const dynamic = "force-dynamic";

export default async function Browse({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const query = typeof q === "string" ? q.slice(0, 100) : "";
  const [page, stats] = await Promise.all([searchLibrary({ q: query }), getStats()]);
  return (
    <div className="mx-auto max-w-7xl px-5 py-12 sm:px-8">
      <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">The library</h1>
      <p className="mt-3 max-w-2xl text-muted">
        {formatCount(stats.tracks)} songs from {formatCount(stats.artists)} artists. Open any of them on YouTube Music.
      </p>
      <div className="mt-10">
        <LibraryBrowser initial={page} initialQuery={query} />
      </div>
    </div>
  );
}
