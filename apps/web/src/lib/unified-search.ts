import { normalizeSearchText, uniqueRecordingResults } from "@mint/client";
import type { PlayerItem } from "./player-protocol";

export { uniqueRecordingResults as uniqueExternalResults };

function textRelevance(value: string, query: string) {
  const text = normalizeSearchText(value);
  if (text === query) return 100;
  if (text.startsWith(`${query} `)) return 80;
  if (text.includes(query)) return 70;
  const words = text.split(" ");
  const terms = query.split(" ");
  return 60 * terms.filter((term) => words.some((word) => word.startsWith(term))).length / terms.length;
}

export function topSearchResult<T extends Pick<PlayerItem, "title" | "artist" | "type">>(query: string, items: T[]): T | null {
  const normalized = normalizeSearchText(query);
  if (!normalized) return null;
  let best: T | null = null, bestScore = -1;
  for (const item of items) {
    const score = textRelevance(item.title, normalized) +
      (item.type === "track" ? 1 : 0) +
      (item.type !== "artist" ? textRelevance(item.artist ?? "", normalized) / 100 : 0);
    if (score > bestScore) { best = item; bestScore = score; }
  }
  return best;
}

export function searchResponseIsCurrent(requestQuery: string, activeQuery: string, aborted: boolean) {
  return !aborted && requestQuery === activeQuery;
}
