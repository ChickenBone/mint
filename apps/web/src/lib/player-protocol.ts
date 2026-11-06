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
  playlistSource: z.literal("spotify").optional(),
  duration: z.number().finite().nonnegative().optional(),
  occurrenceId: z.uuid().optional(),
  queueId: z.union([z.string().regex(/^\d+$/), z.uuid()]).optional(),
});
export type PlayerItem = z.infer<typeof playerItemSchema>;
export const dspSchema = z.object({
  enabled: z.boolean(), preamp: z.number().min(-18).max(0),
  bands: z.array(z.number().min(-12).max(12)).length(10),
  compressor: z.boolean(), crossfade: z.number().min(0).max(12),
  fadeMode: z.enum(["fixed", "smart", "off"]).default("fixed"),
  normalize: z.boolean().default(false), albumSafe: z.boolean().default(true),
  targetLufs: z.number().min(-23).max(-9).default(-16),
  normalizeMode: z.enum(["track", "album", "auto"]).default("auto"),
  limiter: z.boolean().default(true),
  loudnessContour: z.boolean().default(false),
  stereoMode: z.enum(["normal", "crossfeed", "wide"]).default("normal"),
});
export type DspSettings = z.infer<typeof dspSchema>;
export const defaultDsp: DspSettings = {
  enabled: false, preamp: -6, bands: Array(10).fill(0), compressor: false, crossfade: 0,
  fadeMode: "fixed", normalize: false, albumSafe: true, targetLufs: -16,
  normalizeMode: "auto", limiter: true, loudnessContour: false, stereoMode: "normal",
};
export const collectionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("library"),
    query: z.string().max(100).optional(),
    filters: z.object({
      artist: z.string().max(200).optional(),
      album: z.string().max(200).optional(),
      codec: z.string().max(100).optional(),
      minYear: z.number().int().min(1000).max(3000).optional(),
      maxYear: z.number().int().min(1000).max(3000).optional(),
      genre: z.string().max(100).optional(),
      mood: z.string().max(100).optional(),
      minBpm: z.number().min(40).max(240).optional(),
      maxBpm: z.number().min(40).max(240).optional(),
      camelotKey: z.string().max(10).optional(),
      vocalType: z.enum(["vocal", "instrumental", "spoken-word"]).optional(),
    }).optional(),
  }),
  z.object({ kind: z.literal("liked") }),
  // An empty ID means all native likes; a UUID narrows the selection to one liked song.
  z.object({ kind: z.literal("native-liked"), id: z.preprocess(
    (value) => value == null ? "" : value, z.union([z.literal(""), z.uuid()]),
  ) }),
  z.object({ kind: z.literal("playlist"), id: z.uuid() }),
  z.object({ kind: z.literal("spotify"), id: z.uuid() }),
  z.object({ kind: z.literal("artist"), id: z.string().max(20_000).regex(/^ar_[A-Za-z0-9_-]+$/) }),
  z.object({ kind: z.literal("album"), id: z.string().max(20_000).regex(/^al_[A-Za-z0-9_-]+$/) }),
]);
export type PlayerCollection = z.infer<typeof collectionSchema>;
export const catalogPageSchema = z.object({
  items: z.array(playerItemSchema).max(500),
  total: z.number().int().nonnegative(),
  start: z.number().int().nonnegative(),
  title: z.string().optional(),
  artistProfile: z.object({
    status: z.enum(["queued", "fetching", "ready", "not_found", "ambiguous", "failed"]),
    musicBrainzArtistId: z.string().uuid().nullable(),
    profile: z.object({
      artistType: z.string().nullable(),
      area: z.string().nullable(),
      biography: z.string().nullable(),
      biographyUrl: z.string().url().nullable(),
      relatedArtists: z.array(z.object({
        name: z.string(),
        musicBrainzArtistId: z.string().uuid(),
        source: z.enum(["listenbrainz", "musicbrainz"]),
      })),
      listenCount: z.number().int().nonnegative().nullable(),
      listenerCount: z.number().int().nonnegative().nullable(),
      unavailableSources: z.array(z.string()),
    }).nullable(),
    fetchedAt: z.string().datetime().nullable(),
  }).nullable().optional(),
});
export type CatalogPage = z.infer<typeof catalogPageSchema>;
export const playerStateSchema = z.object({
  playing: z.boolean(), time: z.number().finite().nonnegative(), duration: z.number().finite().nonnegative(),
  volume: z.number().min(0).max(100), shuffle: z.boolean(), repeat: z.number().int().min(0).max(2),
  track: playerItemSchema.nullable(), queue: z.array(playerItemSchema).max(1000),
  queueTotal: z.number().int().nonnegative(), queueOffset: z.number().int().nonnegative(),
  dsp: dspSchema.optional(), dspAvailable: z.boolean().optional(), transitioning: z.boolean().optional(),
  transitionDetail: z.string().optional(), normalizationDb: z.number().finite().optional(),
  playbackFormat: z.enum(["original", "mp3"]).optional(),
});
export type PlayerState = z.infer<typeof playerStateSchema>;
export type MusicView = "home" | "library" | "search" | "now-playing";
export type PlayerCommand =
  | { action: "play" | "next-in-queue" | "add-to-queue"; item: PlayerItem; shuffle?: boolean }
  | { action: "collection"; collection: PlayerCollection; shuffle: boolean; id?: string; occurrenceId?: string }
  | { action: "context"; context: z.infer<typeof import("@mint/core/devices").deviceQueueContextSchema>; position: number; paused: boolean; repeat: number }
  | { action: "dsp"; settings: DspSettings }
  | { action: "items"; items: PlayerItem[]; index?: number; position?: number; paused?: boolean; shuffle?: boolean; repeat?: number }
  | { action: "pause" | "resume" }
  | { action: "format"; format: "original" | "mp3" }
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
