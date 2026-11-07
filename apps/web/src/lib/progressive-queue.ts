import { queuePageSchema, type QueuePage } from "@mint/client/playback";
export { queueContextSchema, queuePageSchema, queueOpenSchema, queueEditSchema } from "@mint/client/playback";
export type { QueueContext, QueuePage, QueueEdit } from "@mint/client/playback";
export async function fetchQueue(path: string, value: unknown, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<QueuePage> {
  const response = await fetcher(`/api/player/queue${path}`, {
    method: value === undefined ? "GET" : "POST", cache: "no-store", credentials: "same-origin", signal,
    ...(value === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(value) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "The listening queue could not load.");
  return queuePageSchema.parse(result);
}
