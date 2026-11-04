import { getDb } from "@mint/core/db";
import { toTrackView } from "@mint/core/views";
import { requireUser } from "@/lib/auth";
import { legacyDiscoverHref } from "@/lib/app-routes";
import { discoverMusic } from "@/lib/music-discovery";
import { DiscoveryShelves } from "@/components/app/discovery-shelves";
import { redirect } from "next/navigation";

export default async function DiscoverPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams, params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") params.set(key, value);
    else value?.forEach((item) => params.append(key, item));
  }
  const legacy = legacyDiscoverHref(params);
  if (legacy) redirect(legacy);
  const user = await requireUser();
  const result = await discoverMusic(getDb(), user.id, "for-you", [], 18);
  const artists = [...new Map(result.items.map(({ track }) => [track.artist, track])).values()].slice(0, 3);
  return <DiscoveryShelves seeds={artists.map(toTrackView)} />;
}
