export function reorderedEntries(entries: readonly string[], entryId: string, direction: -1 | 1): string[] {
  const index = entries.indexOf(entryId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= entries.length || new Set(entries).size !== entries.length) {
    throw new Error("The playlist order changed. Reload the playlist and try again.");
  }
  const next = entries.slice();
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}
