import { getDb } from "@mint/core/db";
import { toTrackView } from "@mint/core/views";
import { UUID } from "@mint/core/playback";
import { requireUser } from "@/lib/auth";
import { discoverMusic, type DiscoveryMode } from "@/lib/music-discovery";
import { musicProfile } from "@/lib/music-store";
import { trackPlayerItem } from "@/lib/player-protocol";
import { MusicDiscovery } from "@/components/app/music-discovery";
import { ChartBrowser } from "@/components/app/chart-browser";
import { DiscoveryShelves } from "@/components/app/discovery-shelves";
import { chartPage } from "@/lib/chart-service";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CHARTS } from "@/lib/charts";

export default async function DiscoverPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser(), params = await searchParams;
  const mixes = params.tab === "mixes" || !!params.mode || !!params.seed;
  const navigation = <nav aria-label="Discover views" className="mb-7 flex items-center gap-5 text-sm font-semibold text-muted">
    <Link href="/app/discover" className="inline-flex min-h-11 items-center hover:text-fg">← Discover</Link>
    <Link href="/app/discover?tab=mixes" className="inline-flex min-h-11 items-center hover:text-fg">Your mixes</Link>
    <Link href="/app/discover?tab=charts" className="inline-flex min-h-11 items-center hover:text-fg">All charts</Link>
  </nav>;
  if (!mixes && (params.chart || params.tab === "charts")) {
    const id = typeof params.chart === "string" ? params.chart : "apple-us";
    if (!CHARTS.some((chart) => chart.id === id)) notFound();
    return <>{navigation}<ChartBrowser key={id} initial={await chartPage(id, user.id)} member /></>;
  }
  if (!mixes) {
    const result = await discoverMusic(getDb(), user.id, "for-you", [], 18);
    const artists = [...new Map(result.items.map(({ track }) => [track.artist, track])).values()].slice(0, 3);
    return <DiscoveryShelves seeds={artists.map(toTrackView)} />;
  }
  const seed = [params.seed ?? []].flat().filter((id) => UUID.test(id)).slice(0, 20);
  const mode = ["for-you", "recent", "rediscover", "radio", "sonic"].includes(String(params.mode)) ? params.mode as DiscoveryMode : "for-you";
  const effective = ["radio", "sonic"].includes(mode) && !seed.length ? "for-you" : mode;
  const [result, profile] = await Promise.all([discoverMusic(getDb(), user.id, effective, seed), musicProfile(getDb(), user.id)]);
  return <>{navigation}<MusicDiscovery initialMode={effective} initialSeeds={seed} initial={{ ...result, items: result.items.map(({ track, reason }) => ({
    track: toTrackView(track), item: trackPlayerItem(toTrackView(track)), reason,
  })) }} initialLikes={profile.likes} /></>;
}
