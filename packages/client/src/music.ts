import { z } from "zod";
import { playerItemSchema } from "./playback";

export const trackViewSchema = z.object({
  id: z.uuid(), title: z.string(), artist: z.string(), album: z.string().nullable(),
  year: z.number().nullable(), durationSec: z.number().nullable(), stage: z.string(),
  progress: z.number(), detail: z.string().nullable(), source: z.string().nullable(),
  sonicAnalyzed: z.boolean(), artworkUrl: z.string(), youtubeVideoId: z.string().nullable(), updatedAt: z.string(),
});
export type TrackView = z.infer<typeof trackViewSchema>;
export const collectionRecordSchema = z.object({
  id: z.uuid(), ownerId: z.uuid(), title: z.string(), description: z.string(), artworkUrl: z.string().nullable(),
  rules: z.record(z.string(), z.unknown()).nullable(), revision: z.number().int().positive(),
  createdAt: z.string(), updatedAt: z.string(),
});
export const collectionSummarySchema = collectionRecordSchema.extend({
  role: z.enum(["owner", "editor"]), pinned: z.boolean(), folderId: z.string().nullable(),
});
export type CollectionSummary = z.infer<typeof collectionSummarySchema>;
export const collectionListSchema = z.object({
  collections: z.array(collectionSummarySchema),
  folders: z.array(z.object({ id: z.uuid(), userId: z.uuid(), title: z.string() })),
  invitations: z.array(z.object({ id: z.uuid(), title: z.string(), owner: z.string() })),
});
export type CollectionList = z.infer<typeof collectionListSchema>;
export const collectionDetailSchema = collectionRecordSchema.extend({
  role: z.enum(["owner", "editor"]),
  entries: z.array(z.object({ entryId: z.uuid(), position: z.number().int(), track: trackViewSchema })),
  collaborators: z.array(z.object({ userId: z.uuid(), accepted: z.boolean(), name: z.string(), email: z.string() })),
});
export type CollectionDetail = z.infer<typeof collectionDetailSchema>;
export const discoverySchema = z.object({
  explanation: z.string(),
  items: z.array(z.object({ item: playerItemSchema, track: trackViewSchema, reason: z.string() })).max(50),
});
export type Discovery = z.infer<typeof discoverySchema>;
export type DiscoveryMode = "for-you" | "recent" | "rediscover" | "radio" | "sonic";
export const recordingSearchItemSchema = z.object({
  id: z.uuid(), title: z.string(), artist: z.string(), album: z.string().nullable(), durationSec: z.number().nullable(),
  isrcs: z.array(z.string()).optional(), token: z.string(),
  existing: z.object({
    id: z.uuid(), recordingId: z.string().nullable(), stage: z.string(), error: z.string().nullable(),
    detail: z.string().nullable(), playable: z.boolean(),
  }).nullable(),
});
export type RecordingSearchItem = z.infer<typeof recordingSearchItemSchema>;
export type CollectionMutation =
  | { action: "append"; revision: number; trackIds: string[] }
  | { action: "remove"; revision: number; entryId: string }
  | { action: "reorder"; revision: number; entryIds: string[] }
  | { action: "update"; revision: number; title?: string; description?: string; artworkUrl?: string | null }
  | { action: "delete"; revision: number }
  | { action: "invite"; revision: number; email: string }
  | { action: "revoke"; revision: number; userId: string };
export type HistoryEvent = { eventId: string; trackId: string; listenedMs: number; completed?: boolean; startedAt?: string };
export const preferencesSchema = z.object({ privateSession: z.boolean(), likes: z.array(z.uuid()), exclusions: z.array(z.uuid()) });
export const historySchema = z.object({
  entries: z.array(z.object({
    event: z.object({ id: z.uuid(), trackId: z.uuid(), listenedMs: z.number(), completed: z.boolean(), createdAt: z.string() }),
    track: trackViewSchema,
  })),
});
export type History = z.infer<typeof historySchema>;
export const lyricsSchema = z.object({
  id: z.number().optional(), instrumental: z.boolean(), source: z.enum(["LRCLIB", "Lyrics.ovh"]).optional(),
  plainLyrics: z.string().nullable(), syncedLyrics: z.string().nullable(),
});
export const lyricsResponseSchema = z.object({
  lyrics: lyricsSchema.nullable(), offsetMs: z.number(), corrected: z.boolean().optional(),
  alternatives: z.array(lyricsSchema).optional(), warnings: z.array(z.string()).optional(),
});
export type LyricsResponse = z.infer<typeof lyricsResponseSchema>;
export const offlineEntitlementSchema = z.object({ memberId: z.uuid(), expiresAt: z.number(), token: z.string() });
export type OfflineEntitlement = z.infer<typeof offlineEntitlementSchema>;
export type IssueReportInput = {
  category: "playback" | "lyrics" | "music-info" | "app" | "other"; message: string; context?: string | null;
};
export const trackInfoSchema = z.object({ track: z.object({
  id: z.uuid(), title: z.string(), artist: z.string(), album: z.string().nullable(), year: z.number().nullable(),
  source: z.string().nullable(), codec: z.string().nullable(), existingCodec: z.string().nullable(),
  duration: z.number().nullable(), existingDuration: z.number().nullable(), bytes: z.number().nullable(),
  createdAt: z.string(), plexSonicAnalyzed: z.boolean(), existingPlexSonicAnalyzed: z.boolean(),
  musicbrainzRecordingId: z.string().nullable(), musicbrainzReleaseGroupId: z.string().nullable(),
}) });
export const browseFacets = ["genre", "mood", "decade"] as const;
export type BrowseFacet = typeof browseFacets[number];
export const browseCategoryPageSchema = z.object({
  facet: z.enum(browseFacets), offset: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
  nextOffset: z.number().int().positive().nullable(),
  items: z.array(z.object({
    value: z.string().min(1).max(100), label: z.string().min(1).max(100),
    tracks: z.number().int().nonnegative(), artwork: z.string().max(2048).nullable(),
  })).max(48),
});
export type BrowseCategoryPage = z.infer<typeof browseCategoryPageSchema>;
export const chartDefinitionSchema = z.object({
  id: z.string().min(1).max(100), provider: z.string().max(50), providerName: z.string().max(100),
  title: z.string().max(200), territory: z.string().max(200), description: z.string().max(1000),
  country: z.string().max(10).optional(), genre: z.string().max(100).optional(),
});
export type ChartDefinition = z.infer<typeof chartDefinitionSchema>;
export const chartListSchema = z.object({ charts: z.array(chartDefinitionSchema).max(100) });
export const chartAvailabilitySchema = z.enum(["available", "missing", "ambiguous", "requested", "processing", "failed"]);
export const chartPageSchema = z.object({
  chart: chartDefinitionSchema, status: z.enum(["fresh", "stale", "empty", "error"]),
  period: z.string().nullable(), notice: z.string().nullable(), revision: z.string().nullable(),
  offset: z.number().int().nonnegative(), total: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable(),
  items: z.array(z.object({
    id: z.string().min(1).max(200), rank: z.number().int().min(1).max(50), title: z.string(), artist: z.string(),
    album: z.string().nullable(), durationSec: z.number().nullable(), artwork: z.string().max(2048).nullable(),
    availability: chartAvailabilitySchema, reason: z.string(), progress: z.number().nullable(), item: playerItemSchema.nullable(),
  })).max(50),
});
export type ChartPage = z.infer<typeof chartPageSchema>;
