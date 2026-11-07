import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { BrowseCategoryPage } from "@mint/client";
import { activeTab } from "../src/screens/navigation";
import {
  acceptFacetPage, appendPage, browseHref, browseRows, personalCards, safeArtworkUrl, cardColor, cardPalette, catalogFilters, categoryCards, chartCards, chartStatus,
  facetOrder, gridColumns, nextFacetPage, parseBrowseTarget, titleCase,
} from "../src/screens/browse-model";

const page = (facet: BrowseCategoryPage["facet"], offset: number, nextOffset: number | null, values: string[]): BrowseCategoryPage => ({
  facet, offset, nextOffset, total: offset + values.length + (nextOffset === null ? 0 : 1),
  items: values.map((value) => ({ value, label: value, tracks: value.length, artwork: null })),
});

test("browse category routes stay inside the Search tab", () => {
  assert.equal(activeTab("/browse/genre"), "/search");
  assert.equal(activeTab("/browse/chart"), "/search");
  assert.deepEqual(browseHref({ facet: "genre", value: "ambient" }, "Ambient"),
    { pathname: "/browse/[facet]", params: { facet: "genre", value: "ambient", title: "Ambient" } });
});

test("taxonomy loads facets in display order and follows server cursors to exhaustion", () => {
  assert.deepEqual(facetOrder, ["decade", "mood", "genre"]);
  assert.deepEqual(nextFacetPage({}), { facet: "decade", offset: 0 });
  assert.deepEqual(nextFacetPage({ decade: [page("decade", 0, null, ["1990"])] }), { facet: "mood", offset: 0 });
  assert.deepEqual(nextFacetPage({ decade: [page("decade", 0, null, [])], mood: [page("mood", 0, 24, ["calm"])] }), { facet: "mood", offset: 24 });
  assert.equal(nextFacetPage({
    decade: [page("decade", 0, null, [])], mood: [page("mood", 0, null, [])],
    genre: [page("genre", 0, 24, ["a"]), page("genre", 24, null, ["b"])],
  }), null);
});

test("category cards map real taxonomy rows to distinct filtered destinations", () => {
  const cards = categoryCards(page("mood", 0, null, ["calm", "high energy"]));
  assert.deepEqual(cards.map((card) => [card.key, card.title, card.detail]), [
    ["mood:calm", "Calm", "4 songs"], ["mood:high energy", "High Energy", "11 songs"]]);
  assert.equal(categoryCards(page("genre", 0, null, ["Hip Hop"]))[0]!.title, "Hip Hop");
  assert.equal(categoryCards({ ...page("genre", 0, null, []), items: [{ value: "x", label: "X", tracks: 1, artwork: null }] })[0]!.detail, "1 song");
  assert.deepEqual(new Set(cards.map((card) => JSON.stringify(catalogFilters(card)))).size, cards.length);
  assert.deepEqual(chartCards([{ id: "fixture-week", provider: "fixture", providerName: "Fixture", title: "Fixture Top 50",
    territory: "Worldwide", description: "Fictional." }])[0], {
    facet: "chart", value: "fixture-week", key: "chart:fixture-week", title: "Fixture Top 50", detail: "Fixture", icon: "trending-up" });
  assert.equal(titleCase("drum-n-bass/lo fi"), "Drum-N-Bass/Lo Fi");
});

test("browse grid chunks responsive rows and hides empty sections", () => {
  const cards = categoryCards(page("genre", 0, null, ["a", "b", "c", "d", "e"]));
  const rows = browseRows([{ key: "empty", title: "Empty", cards: [] }, { key: "genre", title: "Genres", cards }], 2);
  assert.deepEqual(rows.map((row) => row.type === "cards" ? row.cards.length : row.title), ["Genres", 2, 2, 1]);
  assert.equal(browseRows([{ key: "genre", title: "Genres", cards }], 0).length, 6);
  assert.deepEqual([375, 600, 900, 1200, 1600].map(gridColumns), [2, 3, 4, 5, 5]);
});

test("category links are validated and filters stay bounded", () => {
  assert.deepEqual(parseBrowseTarget("decade", "1990"), { facet: "decade", value: "1990" });
  assert.deepEqual(catalogFilters({ facet: "decade", value: "1990" }), { minYear: 1990, maxYear: 1999 });
  assert.deepEqual(catalogFilters({ facet: "genre", value: "ambient" }), { genre: "ambient" });
  assert.deepEqual(catalogFilters({ facet: "mood", value: "calm" }), { mood: "calm" });
  assert.equal(catalogFilters({ facet: "chart", value: "fixture" }), null);
  assert.deepEqual(parseBrowseTarget("mix", "for-you"), { facet: "mix", value: "for-you" });
  assert.deepEqual(parseBrowseTarget("new", "albums"), { facet: "new", value: "albums" });
  assert.deepEqual(parseBrowseTarget("chart", "fixture-week"), { facet: "chart", value: "fixture-week" });
  for (const [facet, value] of [["decade", "199"], ["decade", "3000"], ["decade", "1995"], ["mix", "constructor"], ["mix", "toString"],
    ["new", "songs"], ["chart", "../admin"], ["chart", "Fixture"], ["genre", " "], ["genre", "x".repeat(101)], ["podcast", "x"], [undefined, "x"], ["genre", undefined]]) {
    assert.equal(parseBrowseTarget(facet, value), null, `${facet}:${value}`);
  }
});

test("paged results append only continuing pages and remove duplicates", () => {
  const id = (item: { id: string }) => item.id;
  const first = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(appendPage(first, 2, [{ id: "b" }, { id: "c" }], id), [{ id: "a" }, { id: "b" }, { id: "c" }]);
  assert.equal(appendPage(first, 0, [{ id: "z" }], id), first, "Stale pages are ignored.");
  assert.deepEqual(chartStatus("processing", 40), "Being added · 40%");
  assert.equal(chartStatus("available", null), "In your library");
  assert.equal(chartStatus("missing", null), "Not in your library");
});

function contrast(hex: string) {
  const channel = (value: number) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = [1, 3, 5].map((index) => channel(parseInt(hex.slice(index, index + 2), 16)));
  return 1.05 / (0.2126 * r! + 0.7152 * g! + 0.0722 * b! + 0.05);
}
test("card colors are deterministic and keep white titles readable", () => {
  for (const color of cardPalette) assert.ok(contrast(color) >= 4.5, `${color} contrast ${contrast(color).toFixed(2)}`);
  assert.equal(cardColor("genre:ambient"), cardColor("genre:ambient"));
  assert.ok(new Set(["genre:a", "genre:b", "mood:calm", "decade:1990", "chart:x", "mix:for-you"].map(cardColor)).size > 2);
});

test("browse screens are read-only discovery and never acquire from charts", () => {
  const root = resolve(import.meta.dirname, "../src");
  const sources = ["screens/BrowseAll.tsx", "screens/BrowseCategoryScreen.tsx", "components/ui/BrowseCard.tsx", "screens/browse-model.ts"]
    .map((file) => readFileSync(resolve(root, file), "utf8")).join("\n");
  assert.doesNotMatch(sources, /requestRecording|searchRecordings|charts\/request|requestChart|podcast|audiobook/i);
  assert.ok(readdirSync(resolve(import.meta.dirname, "../app/browse")).includes("[facet].tsx"));
  const search = readFileSync(resolve(root, "screens/SearchScreen.tsx"), "utf8");
  assert.match(search, /<BrowseAll/);
  assert.match(search, /requestRecording/, "Explicit Search acquisition stays available.");
});

test("facet pages follow the server cursor and drop stale or repeated pages", () => {
  const first = page("genre", 0, 2, ["a", "b"]);
  const pages = acceptFacetPage({}, first);
  assert.equal(acceptFacetPage(pages, first), pages);
  assert.equal(acceptFacetPage(pages, page("genre", 5, null, ["z"])), pages);
  const next = acceptFacetPage(pages, page("genre", 2, 2, ["c"]));
  assert.equal(next.genre!.length, 2);
  assert.equal(next.genre![1]!.nextOffset, null);
  assert.equal(acceptFacetPage({}, page("mood", 3, null, ["x"])).mood, undefined);
});

test("personal cards place New arrivals after the main mix and skip empty sources", () => {
  const mix = { items: [{ item: { thumb: "/art/1" } }] };
  const cards = personalCards({ mixes: { "for-you": mix, recent: { items: [] }, rediscover: mix }, albums: { total: 3, items: [{ thumb: "/art/2" }] } });
  assert.deepEqual(cards.map((card) => card.key), ["mix:for-you", "new:albums", "mix:rediscover"]);
  assert.deepEqual(personalCards({ mixes: {}, albums: { total: 0, items: [] } }), []);
  assert.deepEqual(personalCards({ mixes: {}, albums: { total: 1, items: [{}] } })[0]!.artwork, null);
});

test("sections render explicit loading and error rows instead of looking empty", () => {
  const retry = () => {};
  const rows = browseRows([
    { key: "you", title: "For you", cards: [], status: { loading: false, error: "Server unavailable", retry } },
    { key: "charts", title: "Charts", cards: [], status: { loading: true, error: null } },
    { key: "done", title: "Done", cards: [], status: { loading: false, error: null } },
  ], 2);
  assert.deepEqual(rows.map((row) => row.type), ["header", "status", "header", "status"]);
  const status = rows[1]!;
  assert.ok(status.type === "status" && status.status.error === "Server unavailable" && status.status.retry === retry);
});

test("rejected artwork addresses fall back and are reported once", () => {
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const api = { artworkUrl: (path: string) => { if (path.startsWith("http")) throw new Error("Blocked artwork origin"); return `https://mint.test${path}`; } };
    assert.equal(safeArtworkUrl(api, "/art/1", "Test"), "https://mint.test/art/1");
    assert.equal(safeArtworkUrl(api, "https://elsewhere.test/a.jpg", "Test"), undefined);
    assert.equal(safeArtworkUrl(api, "https://elsewhere.test/a.jpg", "Test"), undefined);
    assert.equal(safeArtworkUrl(null, "/art/1", "Test"), undefined);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]![0]), /Test artwork unavailable/);
  } finally { console.warn = original; }
});
