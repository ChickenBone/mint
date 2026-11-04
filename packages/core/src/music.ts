import { z } from "zod";

export const smartRulesSchema = z.object({
  artist: z.string().trim().max(200).optional(),
  album: z.string().trim().max(200).optional(),
  title: z.string().trim().max(200).optional(),
  codec: z.string().trim().max(100).optional(),
  liked: z.boolean().optional(),
  neverPlayed: z.boolean().optional(),
  addedWithinDays: z.number().int().min(1).max(3650).optional(),
  minYear: z.number().int().min(1000).max(3000).optional(),
  maxYear: z.number().int().min(1000).max(3000).optional(),
  order: z.enum(["artist", "newest", "least-played"]).default("artist"),
  limit: z.number().int().min(1).max(1000).default(100),
}).refine((value) => !value.minYear || !value.maxYear || value.minYear <= value.maxYear, "Year range is reversed");
export type SmartRules = z.infer<typeof smartRulesSchema>;
export const createCollectionSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).default(""),
  rules: smartRulesSchema.nullable().default(null),
  trackIds: z.array(z.uuid()).max(1000).default([]),
  sourcePlaylistId: z.uuid().optional(),
  sourceCollectionId: z.uuid().optional(),
});
export const collectionMutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("update"), revision: z.number().int().positive(),
    title: z.string().trim().min(1).max(200).optional(), description: z.string().max(2000).optional(),
    artworkUrl: z.union([z.url().max(2048).refine((url) => /^https?:\/\//.test(url), "Use an HTTP image URL"), z.literal("")]).nullable().optional(),
    rules: smartRulesSchema.nullable().optional() }),
  z.object({ action: z.literal("append"), revision: z.number().int().positive(), trackIds: z.array(z.uuid()).min(1).max(1000) }),
  z.object({ action: z.literal("remove"), revision: z.number().int().positive(), entryId: z.uuid() }),
  z.object({ action: z.literal("reorder"), revision: z.number().int().positive(), entryIds: z.array(z.uuid()).max(10000) }),
  z.object({ action: z.literal("delete"), revision: z.number().int().positive() }),
  z.object({ action: z.literal("invite"), revision: z.number().int().positive(), email: z.email().max(320) }),
  z.object({ action: z.literal("revoke"), revision: z.number().int().positive(), userId: z.uuid() }),
]);
export const historyEventSchema = z.object({
  eventId: z.uuid(), trackId: z.uuid(), listenedMs: z.number().int().min(0).max(86_400_000),
  completed: z.boolean().default(false),
  // Required after a privacy/deletion boundary; older queued episodes are intentionally discarded.
  startedAt: z.iso.datetime().optional(),
});
export type HistoryEvent = z.infer<typeof historyEventSchema>;
export type MusicMutation = z.infer<typeof collectionMutationSchema>;
export class MusicError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
