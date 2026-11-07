import type { Metadata } from "next";
import { getDb } from "@mint/core/db";
import { toTrackView } from "@mint/core/views";
import { GlobalSearch } from "@/components/app/global-search";
import { requireUser } from "@/lib/auth";
import { discoverMusic } from "@/lib/music-discovery";

export const metadata: Metadata = { title: "Search" };

export default async function SearchPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [raw, user] = await Promise.all([searchParams, requireUser()]);
  const result = await discoverMusic(getDb(), user.id, "for-you", [], 18);
  const seeds = [...new Map(result.items.map(({ track }) => [track.artist, track])).values()].slice(0, 3);
  const query = typeof raw.q === "string" ? raw.q : raw.q?.[0] ?? "";
  return <GlobalSearch initialQuery={query} discoverySeeds={seeds.map(toTrackView)} />;
}
