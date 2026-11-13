import { z } from "zod";

const text = z.string().min(1).max(2000).refine((value) => !value.includes("\0"));
const cursor = z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/);

export const libraryListInputSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  search: z.string().max(200).refine((value) => !value.includes("\0")).optional(),
  cursor: cursor.optional(),
}).strict();
export type LibraryListInput = z.infer<typeof libraryListInputSchema>;

export const libraryFileListItemSchema = z.object({
  id: z.guid(),
  recordingId: z.guid().nullable(),
  title: text,
  artist: text,
  album: text,
  version: text.nullable(),
  durationMs: z.number().int().min(1).max(2147483647).nullable(),
}).strict();
export type LibraryFileListItem = z.infer<typeof libraryFileListItemSchema>;

export const libraryFilePageSchema = z.object({
  items: z.array(libraryFileListItemSchema).max(100),
  nextCursor: cursor.nullable(),
}).strict().refine((page) => page.nextCursor === null || page.items.length > 0);
export type LibraryFilePage = z.infer<typeof libraryFilePageSchema>;
