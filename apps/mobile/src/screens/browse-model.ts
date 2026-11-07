import type { BrowseCategoryPage, BrowseFacet, CatalogFilters, ChartDefinition, MintApi } from "@mint/client";

export type MixMode = "for-you" | "recent" | "rediscover";
export type BrowseTarget =
  | { facet: BrowseFacet; value: string }
  | { facet: "mix"; value: MixMode }
  | { facet: "new"; value: "albums" }
  | { facet: "chart"; value: string };
export type BrowseCard = BrowseTarget & { key: string; title: string; detail?: string; artwork?: string | null; icon: CardIcon };
export type CardIcon = "sparkles" | "leaf" | "refresh" | "disc" | "trending-up" | "musical-notes" | "color-palette" | "time";
export type SectionStatus = { loading: boolean; error: string | null; retry?: () => void };
export type BrowseSection = { key: string; title: string; cards: BrowseCard[]; status?: SectionStatus };
export type BrowseRow =
  | { key: string; type: "header"; title: string }
  | { key: string; type: "cards"; cards: BrowseCard[] }
  | { key: string; type: "status"; title: string; status: SectionStatus };
export type FacetPages = Partial<Record<BrowseFacet, BrowseCategoryPage[]>>;

export const facetOrder: BrowseFacet[] = ["decade", "mood", "genre"];
export const facetTitles: Record<BrowseFacet, string> = { decade: "Decades", mood: "Moods", genre: "Genres" };
export const mixTitles: Record<MixMode, { title: string; detail: string; icon: CardIcon }> = {
  "for-you": { title: "Made for you", detail: "Picked from your likes and listening", icon: "sparkles" },
  recent: { title: "New in your library", detail: "Songs most recently added", icon: "leaf" },
  rediscover: { title: "Worth another listen", detail: "Songs you have not played lately", icon: "refresh" },
};
const facetIcons: Record<BrowseFacet, CardIcon> = { decade: "time", mood: "color-palette", genre: "musical-notes" };

// Deep, saturated fields keep white titles above 4.5:1 contrast; artwork supplies the remaining color.
export const cardPalette = [
  "#8c2f5c", "#1f5c8c", "#6b44a8", "#9a4320", "#1c6b50", "#7c3b8f",
  "#2c4fa3", "#8a3a2c", "#3a6a24", "#0f6a72", "#a03358", "#4e4aa0",
] as const;

export function cardColor(key: string) {
  let hash = 2166136261;
  for (const char of key) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  return cardPalette[(hash >>> 0) % cardPalette.length]!;
}

export function titleCase(value: string) {
  return value.replace(/(^|[\s/-])(\p{L})/gu, (_, gap: string, letter: string) => gap + letter.toUpperCase());
}

export function categoryCards(page: BrowseCategoryPage): BrowseCard[] {
  return page.items.map((item) => ({
    facet: page.facet, value: item.value, key: `${page.facet}:${item.value}`, icon: facetIcons[page.facet],
    title: page.facet === "mood" ? titleCase(item.label) : item.label, artwork: item.artwork,
    detail: `${item.tracks.toLocaleString("en-US")} ${item.tracks === 1 ? "song" : "songs"}`,
  }));
}

export function chartCards(charts: ChartDefinition[]): BrowseCard[] {
  return charts.map((chart) => ({ facet: "chart", value: chart.id, key: `chart:${chart.id}`, title: chart.title,
    detail: chart.providerName, icon: "trending-up" }));
}

/** Facets load in display order, so appended pages never shift sections above the reader. */
export function nextFacetPage(pages: Partial<Record<BrowseFacet, BrowseCategoryPage[]>>): { facet: BrowseFacet; offset: number } | null {
  for (const facet of facetOrder) {
    const loaded = pages[facet];
    if (!loaded?.length) return { facet, offset: 0 };
    const last = loaded[loaded.length - 1]!;
    if (last.nextOffset !== null) return { facet, offset: last.nextOffset };
  }
  return null;
}

/** Sections with no cards are hidden unless they are still loading or failed, so failures never look like empty success. */
export function browseRows(sections: BrowseSection[], columns: number): BrowseRow[] {
  const width = Math.max(1, Math.floor(columns));
  return sections.flatMap((section) => {
    const status = section.status && (section.status.loading || section.status.error) ? section.status : null;
    if (!section.cards.length && !status) return [];
    return [
      { key: `header:${section.key}`, type: "header" as const, title: section.title },
      ...Array.from({ length: Math.ceil(section.cards.length / width) }, (_, index) => ({
        key: `row:${section.key}:${index}`, type: "cards" as const, cards: section.cards.slice(index * width, index * width + width),
      })),
      ...(status ? [{ key: `status:${section.key}`, type: "status" as const, title: section.title, status }] : []),
    ];
  });
}

/** Accepts a category page only when it continues that facet's server cursor; repeated or stale pages are ignored. */
export function acceptFacetPage(pages: FacetPages, page: BrowseCategoryPage): FacetPages {
  const loaded = pages[page.facet] ?? [];
  const expected = loaded.length ? loaded[loaded.length - 1]!.nextOffset : 0;
  if (expected === null || page.offset !== expected) return pages;
  // A page that does not advance the cursor ends that facet instead of being requested forever.
  const nextOffset = page.nextOffset !== null && page.nextOffset > page.offset ? page.nextOffset : null;
  return { ...pages, [page.facet]: [...loaded, { ...page, nextOffset }] };
}

export type PersonalSources = {
  mixes: Partial<Record<MixMode, { items: { item: { thumb?: string } }[] }>>;
  albums?: { total: number; items: { thumb?: string }[] };
};
export function personalCards({ mixes, albums }: PersonalSources): BrowseCard[] {
  const cards: BrowseCard[] = (Object.keys(mixTitles) as MixMode[]).flatMap((mode) => {
    const result = mixes[mode];
    if (!result?.items.length) return [];
    const { title, detail, icon } = mixTitles[mode];
    return [{ facet: "mix" as const, value: mode, key: `mix:${mode}`, title, detail, icon, artwork: result.items[0]?.item.thumb ?? null }];
  });
  if (albums?.total) {
    const position = cards[0]?.value === "for-you" ? 1 : 0;
    cards.splice(position, 0, { facet: "new", value: "albums", key: "new:albums", title: "New arrivals",
      detail: "Albums recently added", icon: "disc", artwork: albums.items[0]?.thumb ?? null });
  }
  return cards;
}

const reportedArtwork = new Set<string>();
/** Resolves artwork through the client allowlist; rejected addresses fall back to the placeholder and are logged once. */
export function safeArtworkUrl(api: Pick<MintApi, "artworkUrl"> | null | undefined, path: string | null | undefined, context: string) {
  if (!api || !path) return undefined;
  try { return api.artworkUrl(path); } catch (error) {
    if (!reportedArtwork.has(path)) {
      if (reportedArtwork.size > 200) reportedArtwork.clear();
      reportedArtwork.add(path);
      console.warn(`${context} artwork unavailable`, error instanceof Error ? error.message : "Invalid artwork address.");
    }
    return undefined;
  }
}

export function gridColumns(width: number) {
  return width >= 1200 ? 5 : width >= 900 ? 4 : width >= 600 ? 3 : 2;
}

const decadePattern = /^(1\d|2\d)\d0$/;
export function parseBrowseTarget(facet?: string, value?: string): BrowseTarget | null {
  if (!value || value.length > 100) return null;
  if (facet === "genre" || facet === "mood") return value.trim() ? { facet, value } : null;
  if (facet === "decade") return decadePattern.test(value) ? { facet, value } : null;
  if (facet === "mix") return Object.prototype.hasOwnProperty.call(mixTitles, value) ? { facet, value: value as MixMode } : null;
  if (facet === "new") return value === "albums" ? { facet, value } : null;
  if (facet === "chart") return /^[a-z0-9-]+$/.test(value) ? { facet, value } : null;
  return null;
}

export function catalogFilters(target: BrowseTarget): CatalogFilters | null {
  if (target.facet === "genre") return { genre: target.value };
  if (target.facet === "mood") return { mood: target.value };
  if (target.facet === "decade") return { minYear: Number(target.value), maxYear: Number(target.value) + 9 };
  return null;
}

export function browseHref(target: BrowseTarget, title: string) {
  return { pathname: "/browse/[facet]" as const, params: { facet: target.facet, value: target.value, title } };
}

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

export function chartStatus(availability: string, progress: number | null) {
  switch (availability) {
    case "available": return "In your library";
    case "requested": return "Requested";
    case "processing": return progress === null ? "Being added" : `Being added · ${progress}%`;
    case "failed": return "Couldn't be added";
    case "ambiguous": return "Several versions match";
    default: return "Not in your library";
  }
}
