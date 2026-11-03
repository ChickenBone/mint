import type { Metadata } from "next";
import { PageHeader } from "@/components/app/page-header";
import { LibraryBrowser } from "@/components/library-browser";
import { getStats, searchLibrary } from "@/lib/data";
import { formatCount } from "@/lib/format";

export const metadata: Metadata = { title: "Library" };

export default async function Library({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const query = typeof q === "string" ? q.slice(0, 100) : "";
  const [page, stats] = await Promise.all([searchLibrary({ q: query }), getStats()]);
  return (
    <>
      <PageHeader title="Library" sub={`Everything on the server: ${formatCount(stats.tracks)} songs from ${formatCount(stats.artists)} artists, shared by every member.`} />
      <LibraryBrowser initial={page} initialQuery={query} />
    </>
  );
}
