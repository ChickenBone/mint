import type { Metadata } from "next";
import Link from "next/link";
import { LibraryBrowser } from "@/components/library-browser";
import { getUser } from "@/lib/auth";
import { getStats, searchLibrary } from "@/lib/data";
import { formatCount } from "@/lib/format";

export const metadata: Metadata = { title: "Browse", description: "Search every song in the Mint library." };
export const dynamic = "force-dynamic";

export default async function Browse({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const query = typeof q === "string" ? q.slice(0, 100) : "";
  const [page, stats, user] = await Promise.all([searchLibrary({ q: query }), getStats(), getUser()]);
  return (
    <div className="mx-auto max-w-7xl px-5 py-12 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">The library</h1>
          <p className="mt-3 max-w-prose text-muted">
            {formatCount(stats.tracks)} songs from {formatCount(stats.artists)} artists, including indexed songs from the existing library. Public visitors can browse the catalog; approved members can listen.
          </p>
        </div>
        <Link
          href={user ? "/app/library" : "/request-access"}
          className="inline-flex min-h-11 items-center rounded-full bg-mint px-5 text-sm font-bold text-mint-ink hover:bg-mint-strong"
        >
          {user ? "Open in player" : "Request access to listen"}
        </Link>
      </div>
      <div className="mt-10">
        <LibraryBrowser initial={page} initialQuery={query} />
      </div>
    </div>
  );
}
