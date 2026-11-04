import { getDb } from "@mint/core/db";
import { toTrackView } from "@mint/core/views";
import { UUID } from "@mint/core/playback";
import { requireUser } from "@/lib/auth";
import { discoverMusic, type DiscoveryMode } from "@/lib/music-discovery";
import { musicProfile } from "@/lib/music-store";
import { trackPlayerItem } from "@/lib/player-protocol";
import { MusicDiscovery } from "@/components/app/music-discovery";

export default async function DiscoverPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser(), params = await searchParams;
  const seed = [params.seed ?? []].flat().filter((id) => UUID.test(id)).slice(0, 20);
  const mode = ["for-you", "recent", "rediscover", "radio", "sonic"].includes(String(params.mode)) ? params.mode as DiscoveryMode : "for-you";
  const effective = ["radio", "sonic"].includes(mode) && !seed.length ? "for-you" : mode;
  const [result, profile] = await Promise.all([discoverMusic(getDb(), user.id, effective, seed), musicProfile(getDb(), user.id)]);
  return <MusicDiscovery initialMode={effective} initialSeeds={seed} initial={{ ...result, items: result.items.map(({ track, reason }) => ({
    track: toTrackView(track), item: trackPlayerItem(toTrackView(track)), reason,
  })) }} initialLikes={profile.likes} />;
}
