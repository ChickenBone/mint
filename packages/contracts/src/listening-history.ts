import { z } from "zod";
import { libraryFileListItemSchema } from "./library";

export const listeningHistoryListInputSchema = z.object({
  page: z.number().int().min(0).max(10_000).optional(),
}).strict();
export type ListeningHistoryListInput = z.infer<typeof listeningHistoryListInputSchema>;

export const listeningHistoryRecordInputSchema = z.object({
  eventId: z.uuid(),
  mediaFileId: z.uuid(),
  listenedMs: z.number().int().min(0).max(86_400_000),
  completed: z.boolean().default(false),
  startedAt: z.iso.datetime().optional(),
}).strict();
export type ListeningHistoryRecordInput = z.input<typeof listeningHistoryRecordInputSchema>;
export type ListeningHistoryRecord = z.output<typeof listeningHistoryRecordInputSchema>;

export const listeningHistoryDeleteInputSchema = z.object({
  entryId: z.uuid().optional(),
}).strict();
export type ListeningHistoryDeleteInput = z.infer<typeof listeningHistoryDeleteInputSchema>;

export const listeningHistoryPrivateSessionInputSchema = z.object({
  privateSession: z.boolean(),
}).strict();
export type ListeningHistoryPrivateSessionInput = z.infer<typeof listeningHistoryPrivateSessionInputSchema>;

export const listeningHistoryRecordResultSchema = z.object({ recorded: z.boolean() }).strict();
export const listeningHistoryPrivateSessionSchema = z.boolean();
export const listeningHistoryEntrySchema = z.object({
  event: z.object({
    id: z.uuid(),
    createdAt: z.iso.datetime(),
    listenedMs: z.number().int().min(0).max(86_400_000),
    completed: z.boolean(),
  }).strict(),
  track: libraryFileListItemSchema,
}).strict();
export const listeningHistoryPageSchema = z.object({
  entries: z.array(listeningHistoryEntrySchema).max(101),
}).strict();
export type ListeningHistoryEntry = z.infer<typeof listeningHistoryEntrySchema>;
export type ListeningHistoryPage = z.infer<typeof listeningHistoryPageSchema>;
