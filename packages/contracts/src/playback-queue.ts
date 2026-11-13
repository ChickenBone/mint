import { z } from "zod";
import { libraryFileListItemSchema } from "./library";

const uuid = z.uuid();
const queueSelectionItemSchema = z.object({
  mediaFileId: uuid,
  occurrenceId: uuid.optional(),
}).strict();

export const playbackQueueSelectionSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("library"),
    search: z.string().max(200).refine((value) => !value.includes("\0")).optional(),
  }).strict(),
  z.object({
    source: z.literal("items"),
    items: z.array(queueSelectionItemSchema).min(1).max(5000),
  }).strict(),
]);
export type PlaybackQueueSelection = z.infer<typeof playbackQueueSelectionSchema>;

const currentQueueItemSchema = z.object({
  mediaFileId: uuid,
  occurrenceId: uuid.optional(),
}).strict();

export const playbackQueueOpenInputSchema = z.object({
  selection: playbackQueueSelectionSchema,
  shuffle: z.boolean(),
  current: currentQueueItemSchema.optional(),
}).strict().superRefine((input, ctx) => {
  if (!input.current) return;
  if (input.selection.source === "library" && input.current.occurrenceId) {
    ctx.addIssue({ code: "custom", path: ["current", "occurrenceId"], message: "Library selections have no source occurrence ID" });
    return;
  }
  if (input.selection.source === "items" && !input.selection.items.some((item) =>
    item.mediaFileId === input.current!.mediaFileId
    && (input.current!.occurrenceId === undefined || item.occurrenceId === input.current!.occurrenceId))) {
    ctx.addIssue({ code: "custom", path: ["current"], message: "The current item must be part of the selection" });
  }
});
export type PlaybackQueueOpenInput = z.infer<typeof playbackQueueOpenInputSchema>;

export const playbackQueueContextSchema = z.object({
  id: uuid,
  total: z.number().int().min(0).max(2_147_483_647),
  revision: z.number().int().positive(),
  offset: z.number().int().min(0).max(2_147_483_647),
  position: z.number().int().min(0).max(2_147_483_647),
  shuffle: z.boolean(),
}).strict();
export type PlaybackQueueContext = z.infer<typeof playbackQueueContextSchema>;

export const playbackQueueItemSchema = libraryFileListItemSchema.extend({
  queueId: uuid,
  occurrenceId: uuid.optional(),
}).strict();
export type PlaybackQueueItem = z.infer<typeof playbackQueueItemSchema>;

export const playbackQueuePageSchema = z.object({
  context: playbackQueueContextSchema,
  items: z.array(playbackQueueItemSchema).max(100),
}).strict().superRefine(({ context, items }, ctx) => {
  if (context.total === 0) {
    if (context.offset !== 0 || context.position !== 0 || items.length !== 0) {
      ctx.addIssue({ code: "custom", path: ["context"], message: "An empty queue has no page position" });
    }
    return;
  }
  if (context.position >= context.total || context.offset > context.position
    || context.offset + items.length > context.total) {
    ctx.addIssue({ code: "custom", path: ["context"], message: "Queue page is outside its snapshot" });
  }
});
export type PlaybackQueuePage = z.infer<typeof playbackQueuePageSchema>;

export const playbackQueuePageInputSchema = z.object({
  position: z.number().int().min(0).max(2_147_483_647),
}).strict();
export type PlaybackQueuePageInput = z.infer<typeof playbackQueuePageInputSchema>;
export const playbackQueuePageRequestSchema = z.object({
  queueId: uuid,
  position: playbackQueuePageInputSchema.shape.position,
}).strict();
export type PlaybackQueuePageRequest = z.infer<typeof playbackQueuePageRequestSchema>;

export const playbackQueueEditSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("shuffle"), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal("remove"), entryId: uuid }).strict(),
  z.object({ action: z.literal("move"), entryId: uuid, before: uuid }).strict(),
  z.object({ action: z.literal("clear") }).strict(),
  z.object({
    action: z.literal("append"),
    selection: playbackQueueSelectionSchema,
    next: z.boolean(),
  }).strict(),
]);
export type PlaybackQueueEdit = z.infer<typeof playbackQueueEditSchema>;

export const playbackQueueEditInputSchema = z.object({
  revision: z.number().int().positive(),
  currentEntryId: uuid,
  edit: playbackQueueEditSchema,
}).strict();
export type PlaybackQueueEditInput = z.infer<typeof playbackQueueEditInputSchema>;
export const playbackQueueEditRequestSchema = z.object({
  queueId: uuid,
  revision: playbackQueueEditInputSchema.shape.revision,
  currentEntryId: playbackQueueEditInputSchema.shape.currentEntryId,
  edit: playbackQueueEditSchema,
}).strict();
export type PlaybackQueueEditRequest = z.infer<typeof playbackQueueEditRequestSchema>;
