import type { QueueEntry, QueuePage } from "./types";

export function queueEntries(page: QueuePage): QueueEntry[] {
  const entries = page.items.map((item) => {
    const occurrenceId = item.occurrenceId ?? item.queueId;
    if (!occurrenceId) throw new Error("The server did not identify this queue occurrence.");
    return { ...item, occurrenceId };
  });
  if (new Set(entries.map((entry) => entry.occurrenceId)).size !== entries.length) {
    throw new Error("The server returned duplicate queue identities.");
  }
  return entries;
}

export function shuffleUpcoming(entries: QueueEntry[], current: number, random = Math.random): QueueEntry[] {
  const tail = entries.slice(current + 1);
  for (let i = tail.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [tail[i], tail[j]] = [tail[j]!, tail[i]!];
  }
  return [...entries.slice(0, current + 1), ...tail];
}

export function editUpcoming(
  entries: QueueEntry[], current: number, id: string, before?: string,
): QueueEntry[] {
  const source = entries.findIndex((entry) => entry.occurrenceId === id);
  if (source <= current) throw new Error("Only upcoming songs can be edited.");
  const next = entries.filter((entry) => entry.occurrenceId !== id);
  if (!before) return next;
  if (before === id) return entries;
  const target = next.findIndex((entry) => entry.occurrenceId === before);
  if (target <= current) throw new Error("Move songs within the upcoming queue.");
  next.splice(target, 0, entries[source]!);
  return next;
}
