import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { catalogCollectionResponseSchema, type CatalogPage, type CatalogQuery, type ExternalCatalogItem } from "@mint/client";
import { JsxEmit, ModuleKind, transpileModule } from "typescript";
import * as jsx from "react/jsx-runtime";
import * as artistModel from "../src/features/artists/artist-model";
import { catalogPage } from "./helpers/music-fixtures";

const { artistSelection, groupArtistAlbums, loadArtistDetail, mergeArtistAlbums } = artistModel;

test("artists load bounded songs, album shelf and attributed biography without playlist metadata", async () => {
  const signal = new AbortController().signal;
  const calls: CatalogQuery[] = [];
  const profile: CatalogPage = { ...catalogPage, artistProfile: {
    status: "ready", musicBrainzArtistId: null, fetchedAt: null,
    profile: { artistType: "Group", area: null, biography: "Fixture biography", biographyUrl: null,
      relatedArtists: [], listenCount: null, listenerCount: null, unavailableSources: [] },
  } };
  const result = await loadArtistDetail({
    catalog: async (query, passed) => { assert.equal(passed, signal); calls.push(query!); return query!.type === "track" ? profile : catalogPage; },
  }, "ar_fixture", 100, signal);
  assert.deepEqual(calls, [
    { type: "track", kind: "artist", id: "ar_fixture", size: 100, start: 100 },
    { type: "album", kind: "artist", id: "ar_fixture", size: 20 },
  ]);
  assert.equal(result.albums, catalogPage);
  assert.equal(result.page.artistProfile?.profile?.biography, "Fixture biography");
  assert.deepEqual(artistSelection("ar_fixture"), { kind: "artist", id: "ar_fixture" });
  assert.ok(!("metadata" in result));
  await assert.rejects(loadArtistDetail(null, "ar_fixture", 0, signal), /Sign in/);
  await assert.rejects(loadArtistDetail({ catalog: async () => { throw new Error("Artist unavailable"); } }, "ar_fixture", 0, signal), /Artist unavailable/);
});

const bridgeAlbum = (id: string, title: string, artist = "A Band"): ExternalCatalogItem => ({
  id, title, artist, source: "musicbrainz", playable: false, url: `https://musicbrainz.org/release-group/${id}`,
});

test("legacy title collisions are omitted while distinct bridge release groups remain available", () => {
  const local = [{ id: "al_name_based", type: "album" as const, title: "Échoes", artist: "A Band" }];
  const first = bridgeAlbum("00000000-0000-4000-8000-000000000001", "Echoes");
  const second = bridgeAlbum("00000000-0000-4000-8000-000000000002", "Echoes");
  const albums = mergeArtistAlbums(local, [
    { id: "al_name_based", title: "Echoes", artist: "A Band", verifiedReleaseGroupId: first.id },
    { id: "al_night_one", title: "Nîght", artist: "A Band", verifiedReleaseGroupId: first.id },
    { id: "al_night_two", title: "Night", artist: "A Band", verifiedReleaseGroupId: second.id },
    { id: "al_duplicate", title: "Different one", artist: "A Band", verifiedReleaseGroupId: first.id },
    { id: "al_duplicate", title: "Different two", artist: "A Band", verifiedReleaseGroupId: second.id },
    { id: "al_live", title: "Echoes (Live)", artist: "A Band" },
    { id: "al_deluxe", title: "Echoes (Deluxe)", artist: "A Band" },
  ]);
  assert.deepEqual(albums.map((entry) => [entry.source, entry.source === "library" ? entry.item.id : entry.album.id]), [
    ["library", "al_name_based"], ["catalog", "al_live"], ["catalog", "al_deluxe"],
  ], "Indistinguishable legacy routes are omitted, not assumed to be the same release group.");

  const grouped = groupArtistAlbums(albums, [first, first, second]);
  assert.deepEqual(grouped.map((entry) => [entry.source, entry.source === "library" ? entry.item.id : entry.album.id]), [
    ["library", "al_name_based"], ["catalog", "al_live"], ["catalog", "al_deluxe"], ["bridge", first.id], ["bridge", second.id],
  ], "Same titles do not imply an edition relationship; exact bridge IDs are deduplicated.");
});

test("verified direct album IDs suppress only the same canonical bridge release group", () => {
  const verified = bridgeAlbum("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Different metadata");
  const other = bridgeAlbum("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Echoes (Live)");
  const unverified = bridgeAlbum("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "Echoes (Deluxe)");
  const recordingUrl = { ...verified, url: `https://musicbrainz.org/recording/${verified.id}` };
  const nonCanonicalUrl = { ...verified, url: `${verified.url}?source=catalog` };
  const response = catalogCollectionResponseSchema.parse({
    items: [],
    albums: [
      { id: "al_verified", title: "Echoes (Live)", artist: "A Band", verifiedReleaseGroupId: verified.id },
      { id: "al_unknown", title: "Echoes (Deluxe)", artist: "A Band" },
    ],
    catalog: { status: "ok", mode: "lexical", relevance: "matched", hasMore: false, retryAfterSeconds: null },
  });
  const albums = mergeArtistAlbums([], response.albums);
  const grouped = groupArtistAlbums(albums, [verified, other, unverified, recordingUrl, nonCanonicalUrl]);
  assert.deepEqual(grouped.map((entry) => [entry.source, entry.source === "library" ? entry.item.id : entry.album.id]), [
    ["catalog", "al_verified"], ["catalog", "al_unknown"], ["bridge", other.id], ["bridge", unverified.id],
    ["bridge", verified.id], ["bridge", verified.id],
  ], "Matching names, absent identity, and non-canonical URLs are not proof of a release-group match.");
  assert.deepEqual(grouped.flatMap((entry) => entry.source === "bridge" ? [entry.album.url] : []),
    [other.url, unverified.url, recordingUrl.url, nonCanonicalUrl.url]);
});

test("conflicting explicit release-group IDs do not suppress a bridge album", () => {
  const first = bridgeAlbum("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Echoes");
  const second = bridgeAlbum("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Echoes");
  const albums = mergeArtistAlbums([], [{
    id: `mbal_${first.id}`, title: "Echoes", artist: "A Band", verifiedReleaseGroupId: second.id,
  }]);
  assert.deepEqual(groupArtistAlbums(albums, [first, second]).map((entry) => entry.source), ["catalog", "bridge", "bridge"]);
});

test("artist albums collapse only explicitly identified release groups", () => {
  const first = bridgeAlbum("00000000-0000-4000-8000-000000000001", "Echoes");
  const second = bridgeAlbum("00000000-0000-4000-8000-000000000002", "Echoes");
  const third = bridgeAlbum("00000000-0000-4000-8000-000000000003", "Echoes");
  const fourth = bridgeAlbum("00000000-0000-4000-8000-000000000004", "Echoes");
  const albums = mergeArtistAlbums([
    { id: `mbal_${first.id}`, type: "album" as const, title: "Other name" },
  ], [
    { id: `mbal_${first.id}`, title: "Echoes", artist: "A Band" },
    { id: `mbal_${second.id}`, title: "Echoes", artist: "A Band" },
    { id: `mbal_${third.id}`, title: "Echoes", artist: "A Band" },
  ]);
  assert.deepEqual(albums.map((entry) => entry.source), ["library", "catalog", "catalog"]);
  const grouped = groupArtistAlbums(albums, [first, second, third, fourth]);
  assert.deepEqual(grouped.map((entry) => [entry.source, entry.source === "library" ? entry.item.id : entry.album.id]), [
    ["library", `mbal_${first.id}`], ["catalog", `mbal_${second.id}`], ["catalog", `mbal_${third.id}`], ["bridge", fourth.id],
  ]);
});

test("the artist shelf presents ambiguous albums as separate, independently labeled navigation", async () => {
  const first = bridgeAlbum("00000000-0000-4000-8000-000000000001", "Echoes");
  const second = bridgeAlbum("00000000-0000-4000-8000-000000000002", "Echoes");
  const albums = mergeArtistAlbums([{ id: "al_name", type: "album", title: "Echoes", artist: "A Band" }], [
    { id: "al_name", title: "Echoes", artist: "A Band" },
    { id: "al_name", title: "Echoes", artist: "A Band" },
    { id: "al_live", title: "Echoes (Live)", artist: "A Band" },
    { id: "al_deluxe", title: "Echoes (Deluxe)", artist: "A Band" },
  ]);
  const navigations: { pathname: string; params: { id: string } }[] = [];
  const paths: string[] = [];
  const loaders: ((signal: AbortSignal) => Promise<unknown>)[] = [];
  const data = { configured: true, items: [first, second], nextCursor: null };
  const exports: { CatalogArtistAlbums?: (props: unknown) => unknown } = {};
  const compiled = transpileModule(readFileSync(resolve("src/features/artists/CatalogArtistAlbums.tsx"), "utf8"),
    { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText;
  runInNewContext(compiled, {
    exports, URLSearchParams,
    require(name: string) {
      if (name === "react/jsx-runtime") return jsx;
      if (name === "react") return { useState: (value: unknown) => [value, () => {}] };
      if (name === "react-native") return { Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text" };
      if (name === "expo-router") return { router: { push: (target: typeof navigations[number]) => navigations.push(target) } };
      if (name === "@mint/client") return { externalCatalogPageSchema: {} };
      if (name === "../../api") return { useApi: () => ({ request: async (path: string) => { paths.push(path); return data; } }) };
      if (name === "../../components/music/CollectionDetail") return { detailStyles: {} };
      if (name === "../../components/ui/music") return { MusicCard: "MusicCard", musicStyles: {} };
      if (name === "../../components/ui/primitives") return { Artwork: "Artwork", Button: "Button", Notice: "Notice", Section: "Section" };
      if (name === "../../hooks/useResource") return { useResource: (load: (signal: AbortSignal) => Promise<unknown>) => {
        loaders.push(load);
        return { data, loading: false, error: null, reload() {} };
      } };
      assert.equal(name, "./artist-model");
      return artistModel;
    },
  });
  type Element = { type: unknown; key: string | null; props: { children?: unknown; [key: string]: unknown } };
  const elements = (node: unknown): Element[] => {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!node || typeof node !== "object" || !("props" in node)) return [];
    const element = node as Element;
    return [element, ...elements(element.props.children)];
  };
  const node = exports.CatalogArtistAlbums!({ artistMbid: "artist-id", albums, waiting: false });
  assert.equal(loaders.length, 1);
  await loaders[0]!(new AbortController().signal);
  assert.deepEqual(paths, ["catalog/artists/artist-id/albums?limit=50"]);
  const all = elements(node);
  assert.equal(all.filter((item) => item.type === "MusicCard").length, 1);
  const cards = all.filter((item) => item.type === "Pressable");
  assert.equal(cards.length, 4);
  assert.equal(new Set(cards.map((card) => card.key)).size, 4);
  assert.deepEqual(cards.map((card) => card.props.accessibilityLabel), [
    "Browse catalog album Echoes (Live) by A Band", "Browse catalog album Echoes (Deluxe) by A Band",
    "Browse MusicBrainz catalog album Echoes by A Band", "Browse MusicBrainz catalog album Echoes by A Band",
  ]);
  for (const card of cards) (card.props.onPress as () => void)();
  assert.deepEqual(navigations.map((target) => target.params.id),
    ["al_live", "al_deluxe", `mbal_${first.id}`, `mbal_${second.id}`]);
});

test("artist selector isolates song and album content while keeping collection playback", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../src/features/artists/ArtistScreen.tsx"), "utf8");
  assert.match(source, /accessibilityRole="tab"/);
  assert.match(source, /accessibilityState=\{\{ selected: section === value \}\}/);
  assert.match(source, /section === "songs" \? <Section title="Songs">[\s\S]*<CatalogCollectionRows[\s\S]*<\/Section> : <>[\s\S]*<CatalogArtistAlbums/);
  assert.match(source, /player\.playCollection\(selection\)/);
  assert.match(source, /player\.playCollection\(selection, \{ shuffle: true \}\)/);
});
