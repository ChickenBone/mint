import { z } from "zod";

export const playerItemSchema = z.object({
  key: z.string().max(20_000).regex(/^\/(?:library\/metadata\/[A-Za-z0-9_,=-]+(?:\/(?:children|allLeaves))?|playlists\/(?:liked|[0-9a-f-]{36})(?:\/items)?)$/),
  ratingKey: z.string().max(20_000),
  title: z.string().max(1000),
  type: z.enum(["track", "album", "artist", "playlist"]),
  artist: z.string().max(1000).optional(),
  album: z.string().max(1000).optional(),
  thumb: z.string().max(2048).optional(),
  parentKey: z.string().max(20_000).optional(),
  grandparentKey: z.string().max(20_000).optional(),
  queueId: z.string().regex(/^\d+$/).optional(),
});
export type PlayerItem = z.infer<typeof playerItemSchema>;
export const playerStateSchema = z.object({
  playing: z.boolean(), time: z.number().finite().nonnegative(), duration: z.number().finite().nonnegative(),
  volume: z.number().min(0).max(100), shuffle: z.boolean(), repeat: z.number().int().min(0).max(2),
  track: playerItemSchema.nullable(), queue: z.array(playerItemSchema).max(1000),
  queueTotal: z.number().int().nonnegative(), queueOffset: z.number().int().nonnegative(),
});
export type PlayerState = z.infer<typeof playerStateSchema>;
export type MusicView = "home" | "library" | "search" | "now-playing";
export type PlayerCommand =
  | { action: "play" | "next-in-queue" | "add-to-queue" | "browse"; item: PlayerItem }
  | { action: "navigate"; view: MusicView }
  | { action: "toggle" | "previous" | "next" | "shuffle" | "repeat" | "clear" | "state" }
  | { action: "seek" | "volume"; value: number }
  | { action: "skip" | "remove"; queueId: string };
export const PLAYER_CHANNEL = "mint-player-v2";

function identity(value: string) {
  const bytes = new TextEncoder().encode(value);
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export const albumPlayerId = (artist: string, album: string) => `al_${identity(JSON.stringify([artist, album]))}`;
export const artistPlayerId = (artist: string) => `ar_${identity(artist)}`;

export function trackPlayerItem(track: { id: string; title: string; artist: string; album: string | null; artworkUrl: string }): PlayerItem {
  return { key: `/library/metadata/${track.id}`, ratingKey: track.id, type: "track",
    title: track.title, artist: track.artist, album: track.album ?? undefined, thumb: track.artworkUrl || undefined,
    parentKey: `/library/metadata/${albumPlayerId(track.artist, track.album ?? "")}`, grandparentKey: `/library/metadata/${artistPlayerId(track.artist)}` };
}
