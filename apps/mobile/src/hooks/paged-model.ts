/** Appends a fetched page only when it continues the current window; stale or repeated pages are ignored. */
export function appendPage<T>(items: T[], start: number, page: T[], identity: (item: T) => string) {
  if (start !== items.length) return items;
  const seen = new Set(items.map(identity));
  return [...items, ...page.filter((item) => {
    const key = identity(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  })];
}
