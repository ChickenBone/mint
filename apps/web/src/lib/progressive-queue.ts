import { z } from "zod";
import { collectionSchema, playerItemSchema } from "./player-protocol";
import { deviceQueueContextSchema } from "@mint/core/devices";

export const queueContextSchema = deviceQueueContextSchema;
export type QueueContext = z.infer<typeof queueContextSchema>;
export const queuePageSchema = z.object({ context: queueContextSchema, items: z.array(playerItemSchema).max(100) });
export type QueuePage = z.infer<typeof queuePageSchema>;
export const queueOpenSchema = z.object({ collection: collectionSchema, shuffle: z.boolean(), trackId: z.uuid().optional(), occurrenceId: z.uuid().optional() });
export const queueEditSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("shuffle"), enabled: z.boolean() }),
  z.object({ action: z.literal("remove"), entryId: z.uuid() }),
  z.object({ action: z.literal("move"), entryId: z.uuid(), before: z.uuid() }),
  z.object({ action: z.literal("clear") }),
  z.object({ action: z.literal("append"), trackIds: z.array(z.uuid()).min(1).max(5000), next: z.boolean() }),
  z.object({ action: z.literal("append-collection"), collection: collectionSchema, next: z.boolean() }),
]);
export type QueueEdit = z.infer<typeof queueEditSchema>;
export async function fetchQueue(path: string, value: unknown, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<QueuePage> {
  const response = await fetcher(`/api/player/queue${path}`, {
    method: value === undefined ? "GET" : "POST", cache: "no-store", credentials: "same-origin", signal,
    ...(value === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(value) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "The listening queue could not load.");
  return queuePageSchema.parse(result);
}
