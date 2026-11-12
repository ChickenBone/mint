import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import type { CatalogQuery, ExternalCatalogItem, ExternalCatalogPage, RecordingSearchItem } from "@mint/client";
import { JsxEmit, ModuleKind, transpileModule } from "typescript";
import * as jsx from "react/jsx-runtime";
import * as albumModel from "../src/features/albums/album-model";
import { catalogPage } from "./helpers/music-fixtures";

const { albumSelection, loadAlbumDetail, visibleBridgeRecordings } = albumModel;

test("albums load only bounded album songs, never editable playlist metadata", async () => {
  const signal = new AbortController().signal;
  const calls: CatalogQuery[] = [];
  const result = await loadAlbumDetail({
    catalog: async (query, passed) => { assert.equal(passed, signal); calls.push(query!); return catalogPage; },
  }, "al_fixture", 100, signal);
  assert.deepEqual(calls, [{ type: "track", kind: "album", id: "al_fixture", size: 100, start: 100 }]);
  assert.equal(result.page, catalogPage);
  assert.equal(result.page.items[0]?.artistId, "ar_fixture", "album-to-artist navigation metadata stays available");
  assert.deepEqual(albumSelection("al_fixture"), { kind: "album", id: "al_fixture" }, "Play selects the full album, not the displayed page");
  assert.ok(!("metadata" in result), "albums cannot acquire playlist mutation controls");
  await assert.rejects(loadAlbumDetail(null, "al_fixture", 0, signal), /Sign in/);
  await assert.rejects(loadAlbumDetail({ catalog: async () => { throw new Error("Album unavailable"); } }, "al_fixture", 0, signal), /Album unavailable/);
});

test("album catalog and bridge recordings collapse only exact recording identities", () => {
  const bridge = (id: string, title: string): ExternalCatalogItem => ({
    id, title, artist: "A Band", source: "musicbrainz", playable: false, url: `https://musicbrainz.org/recording/${id}`,
  });
  const first = bridge("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Echo");
  const different = bridge("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Echo");
  const fromCollection = bridge("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "Another Song");
  const collection: RecordingSearchItem[] = [{
    id: fromCollection.id.toUpperCase(), title: fromCollection.title, artist: fromCollection.artist, album: null, durationSec: null,
    token: "signed", existing: null,
  }];
  assert.deepEqual(visibleBridgeRecordings([first, different, fromCollection, first], collection), [first, different],
    "Different recording IDs stay discoverable, even with the same title.");
  assert.deepEqual(visibleBridgeRecordings([first], []), [first]);
});

type Element = { type: unknown; props: { children?: unknown; [key: string]: unknown } };
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}

function renderBridge(page: ExternalCatalogPage, local: boolean, collectionItems: RecordingSearchItem[] = []) {
  const paths: string[] = [];
  const imports: unknown[] = [];
  const loaders: ((signal: AbortSignal) => Promise<unknown>)[] = [];
  const api = {
    request: async (path: string) => { paths.push(path); return page; },
    requestRecording: async (input: unknown) => { imports.push(input); return { stage: "queued" }; },
    trackInfo: async () => { throw new Error("Unexpected per-track lookup"); },
  };
  const exports: { CatalogAlbumRecordings?: (props: unknown) => unknown } = {};
  const compiled = transpileModule(readFileSync(resolve("src/features/albums/CatalogAlbumScreen.tsx"), "utf8"),
    { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText;
  runInNewContext(compiled, {
    exports, URLSearchParams,
    require(name: string) {
      if (name === "react/jsx-runtime") return jsx;
      if (name === "react") return { useState: (value: unknown) => [value, () => {}] };
      if (name === "react-native") return { ScrollView: "ScrollView", Text: "Text", View: "View" };
      if (name === "@mint/client") return { externalCatalogPageSchema: {} };
      if (name === "../../api") return { useApi: () => api };
      if (name === "../../components/music/CollectionDetail") return { detailStyles: {} };
      if (name === "../../components/music/screen-styles") return { screenStyles: {} };
      if (name === "../../components/ui/PageTitle") return { PageTitle: "PageTitle" };
      if (name === "../../components/ui/primitives") return { Button: "Button", Notice: "Notice" };
      if (name === "../../hooks/useResource") return { useResource: (load: (signal: AbortSignal) => Promise<unknown>) => {
        loaders.push(load);
        return { data: page, loading: false, error: null, reload() {} };
      } };
      assert.equal(name, "./album-model");
      return albumModel;
    },
  });
  const node = exports.CatalogAlbumRecordings!({ id: "al_fixture", local, collectionItems });
  return { node, paths, imports, loaders };
}

test("verified library album uses the filtered bridge page without per-track lookups and retains paging", async () => {
  const cursor = "00000000-0000-4000-8000-000000000001";
  const view = renderBridge({ configured: true, items: [], nextCursor: cursor }, true);
  assert.equal(view.loaders.length, 1);
  await view.loaders[0]!(new AbortController().signal);
  assert.deepEqual(view.paths, ["catalog/library-albums/al_fixture/recordings?limit=50"]);
  const nodes = elements(view.node);
  assert.ok(nodes.some((node) => node.type === "Notice" && node.props.title === "No additional recordings on this page"));
  assert.ok(nodes.some((node) => node.type === "Button" && node.props.label === "More recordings"),
    "A fully filtered page still exposes its continuation.");
  assert.equal(renderBridge({ configured: true, identityVerified: false, items: [], nextCursor: null }, true).node, null);
});

test("direct catalog albums remain unfiltered and request audio only on an explicit action", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const item: ExternalCatalogItem = {
    id, title: "Echo", artist: "A Band", source: "musicbrainz", playable: false,
    url: `https://musicbrainz.org/recording/${id}`, requestToken: "fixture-token",
  };
  const view = renderBridge({ configured: true, items: [item], nextCursor: null }, false);
  assert.equal(view.loaders.length, 1);
  await view.loaders[0]!(new AbortController().signal);
  assert.deepEqual(view.paths, ["catalog/albums/al_fixture/recordings?limit=50"]);
  assert.equal(Number(view.imports.length), 0);
  const button = elements(view.node).find((node) => node.type === "Button" && node.props.label === "Add to library");
  assert.ok(button);
  (button.props.onPress as () => void)();
  assert.equal(view.imports.length, 1);
  assert.equal((view.imports[0] as { token: string }).token, "fixture-token");
  assert.deepEqual(Object.keys(view.imports[0] as object), ["token"]);
});
