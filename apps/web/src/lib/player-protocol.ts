import { z } from "zod";

export const playerItemSchema = z.object({
  id: z.string().min(1).max(20_000),
  title: z.string().max(1000),
  type: z.enum(["track", "album", "artist", "playlist"]),
  artist: z.string().max(1000).optional(),
  album: z.string().max(1000).optional(),
  thumb: z.string().max(2048).optional(),
  albumId: z.string().max(20_000).optional(),
  artistId: z.string().max(20_000).optional(),
  duration: z.number().finite().nonnegative().optional(),
  queueId: z.string().regex(/^\d+$/).optional(),
});
export type PlayerItem = z.infer<typeof playerItemSchema>;
export const dspSchema = z.object({
  enabled: z.boolean(), preamp: z.number().min(-18).max(0),
  bands: z.array(z.number().min(-12).max(12)).length(10),
  compressor: z.boolean(), crossfade: z.number().min(0).max(12),
});
export type DspSettings = z.infer<typeof dspSchema>;
export const defaultDsp: DspSettings = { enabled: false, preamp: -6, bands: Array(10).fill(0), compressor: false, crossfade: 0 };
export const collectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("library"), query: z.string().max(100).optional() }),
  z.object({ kind: z.literal("liked") }),
  z.object({ kind: z.literal("playlist"), id: z.uuid() }),
  z.object({ kind: z.literal("artist"), id: z.string().max(20_000).regex(/^ar_[A-Za-z0-9_-]+$/) }),
  z.object({ kind: z.literal("album"), id: z.string().max(20_000).regex(/^al_[A-Za-z0-9_-]+$/) }),
]);
export type PlayerCollection = z.infer<typeof collectionSchema>;
export const catalogPageSchema = z.object({
  items: z.array(playerItemSchema).max(500),
  total: z.number().int().nonnegative(),
  start: z.number().int().nonnegative(),
  title: z.string().optional(),
});
export type CatalogPage = z.infer<typeof catalogPageSchema>;
export const playerStateSchema = z.object({
  playing: z.boolean(), time: z.number().finite().nonnegative(), duration: z.number().finite().nonnegative(),
  volume: z.number().min(0).max(100), shuffle: z.boolean(), repeat: z.number().int().min(0).max(2),
  track: playerItemSchema.nullable(), queue: z.array(playerItemSchema).max(1000),
  queueTotal: z.number().int().nonnegative(), queueOffset: z.number().int().nonnegative(),
  dsp: dspSchema.optional(), dspAvailable: z.boolean().optional(), transitioning: z.boolean().optional(),
});
export type PlayerState = z.infer<typeof playerStateSchema>;
export type MusicView = "home" | "library" | "search" | "now-playing";
export type PlayerCommand =
  | { action: "play" | "next-in-queue" | "add-to-queue"; item: PlayerItem; shuffle?: boolean }
  | { action: "collection"; collection: PlayerCollection; shuffle: boolean; id?: string }
  | { action: "dsp"; settings: DspSettings }
  | { action: "toggle" | "previous" | "next" | "shuffle" | "repeat" | "clear" | "state" }
  | { action: "seek" | "volume"; value: number }
  | { action: "skip" | "remove"; queueId: string }
  | { action: "move"; queueId: string; before: string };

function identity(value: string) {
  const bytes = new TextEncoder().encode(value);
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export const albumPlayerId = (artist: string, album: string) => `al_${identity(JSON.stringify([artist, album]))}`;
export const artistPlayerId = (artist: string) => `ar_${identity(artist)}`;

export function trackPlayerItem(track: { id: string; title: string; artist: string; album: string | null; artworkUrl: string }): PlayerItem {
  return { id: track.id, type: "track",
    title: track.title, artist: track.artist, album: track.album ?? undefined, thumb: track.artworkUrl || undefined,
    albumId: albumPlayerId(track.artist, track.album ?? ""), artistId: artistPlayerId(track.artist) };
}
