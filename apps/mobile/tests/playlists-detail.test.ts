import assert from "node:assert/strict";
import test from "node:test";
import type { CatalogQuery, CollectionDetail, CollectionMutation } from "@mint/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, transpileModule } from "typescript";
import * as jsx from "react/jsx-runtime";
import * as playlistModel from "../src/features/playlists/playlist-model";
import { usePlaylistActions } from "../src/features/playlists/usePlaylistActions";
import { harness } from "./helpers/hook-harness";
import { catalogPage, collectionDetail } from "./helpers/music-fixtures";

test("native, source-managed and liked playlists use distinct API selections and metadata access", async () => {
  const signal = new AbortController().signal;
  for (const [id, source, kind, metadata] of [
    [collectionDetail.id, undefined, "playlist", collectionDetail],
    ["import", "spotify", "spotify", null],
    ["liked", undefined, "native-liked", null],
  ] as const) {
    const calls: CatalogQuery[] = [];
    const collections: string[] = [];
    const result = await playlistModel.loadPlaylistDetail({
      catalog: async (query, passed) => { assert.equal(passed, signal); calls.push(query!); return catalogPage; },
      collection: async (key, passed) => { assert.equal(passed, signal); collections.push(key); return collectionDetail; },
    }, id, source, 100, signal);
    assert.deepEqual(calls, [{ type: "track", kind, id: id === "liked" ? "" : id, size: 100, start: 100 }]);
    assert.deepEqual(collections, metadata ? [id] : [], "imports and likes never fetch native edit metadata");
    assert.equal(result.metadata, metadata);
    assert.deepEqual(playlistModel.playlistSelection(id, source), { kind, id: id === "liked" ? "" : id });
  }
  await assert.rejects(playlistModel.loadPlaylistDetail(null, "liked", undefined, 0, signal), /Sign in/);
});

type Node = { props?: { children?: unknown; label?: string; [key: string]: unknown } };
function labels(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(labels);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const props = (node as Node).props!;
  return [...(props.label ? [props.label] : []), ...labels(props.children)];
}

function renderedPlaylist(id: string, metadata: CollectionDetail | null, source?: string) {
  const exports: { PlaylistScreen?: () => Node } = {};
  const compiled = transpileModule(readFileSync(resolve("src/features/playlists/PlaylistScreen.tsx"), "utf8"),
    { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText;
  runInNewContext(compiled, {
    exports,
    require(name: string) {
      if (name === "react/jsx-runtime") return jsx;
      if (name === "react") return { useState: (value: unknown) => [value, () => {}] };
      if (name === "expo-router") return { useLocalSearchParams: () => ({ id, source }), router: {} };
      if (name === "react-native") return { Modal: "Modal", Text: "Text", View: "View" };
      if (name === "../../api") return { useApi: () => ({}) };
      if (name === "../../components/music/CollectionDetail") return { CollectionDetail: "CollectionDetail", detailStyles: {} };
      if (name === "../../components/music/screen-styles") return { screenStyles: {} };
      if (name === "../../components/ui/primitives") return { Button: "Button", Field: "Field", Notice: "Notice" };
      if (name === "../../hooks/useResource") return { useResource: () => ({ data: { page: catalogPage, metadata }, reload() {} }) };
      if (name === "./playlist-model") return playlistModel;
      if (name === "./LikedImports") return { LikedImports: "LikedImports" };
      assert.equal(name, "./usePlaylistActions");
      return { usePlaylistActions: () => ({ editing: false, editingSongs: true, busy: false,
        removeEntry() {}, moveEntry() {}, setName() {}, setEditing() {}, setEditingSongs() {}, setDeleting() {} }) };
    },
  });
  return exports.PlaylistScreen!();
}

test("actual playlist entryscreen emits only supported mutation controls, including occurrence-based song removal", () => {
  for (const [id, metadata, source, expected] of [
    [collectionDetail.id, collectionDetail, undefined, ["Rename", "Done editing", "Make a copy", "Delete playlist"]],
    [collectionDetail.id, { ...collectionDetail, role: "editor" as const }, undefined, ["Rename", "Done editing", "Make a copy"]],
    [collectionDetail.id, { ...collectionDetail, rules: { genre: "ambient" } }, undefined, ["Make a copy", "Delete playlist"]],
    ["import", null, "spotify", ["Make a copy"]],
    ["liked", null, undefined, []],
  ] as const) {
    const screen = renderedPlaylist(id, metadata, source);
    assert.deepEqual(labels(screen.props!.actions), expected);
    const remove = screen.props!.removeSong as (item: typeof catalogPage.items[number]) => unknown;
    assert.equal(typeof remove(catalogPage.items[0]!), metadata && !metadata.rules ? "function" : "undefined");
    assert.equal(remove({ ...catalogPage.items[0]!, occurrenceId: "missing" }), undefined, "ambiguous duplicates are never removed by track ID");
  }
});

test("real playlist action hook preserves revision checks, duplicate occurrences, copy source and error recovery", async () => {
  const mutations: CollectionMutation[] = [];
  const copies: unknown[] = [];
  const destinations: string[] = [];
  let reloads = 0;
  let failure = false;
  const options = {
    id: collectionDetail.id, source: undefined as string | undefined, metadata: collectionDetail, title: "Fixture playlist",
    api: {
      mutateCollection: async (id: string, input: CollectionMutation) => {
        assert.equal(id, collectionDetail.id); mutations.push(input);
        if (failure) throw new Error("Playlist revision changed");
        return { id, revision: 8 };
      },
      createCollection: async (input: { title: string; sourcePlaylistId?: string; sourceCollectionId?: string }) => {
        copies.push(input); return { ...collectionDetail, id: "copy" };
      },
    },
    reload: () => { reloads++; }, onCopied: (id: string) => destinations.push(id), onDeleted: () => destinations.push("/library"),
  };
  const view = await harness(usePlaylistActions, options);
  await view.act(() => { view.current.setEditing(true); view.current.setName("  Renamed  "); });
  await view.act(() => view.current.save());
  assert.deepEqual(mutations[0], { action: "update", revision: 7, title: "Renamed" });
  assert.equal(view.current.editing, false);
  await view.act(() => view.current.moveEntry(collectionDetail.entries[1]!.entryId, -1));
  assert.deepEqual(mutations[1], { action: "reorder", revision: 7, entryIds: collectionDetail.entries.map((entry) => entry.entryId).reverse() });
  await view.act(() => view.current.removeEntry(collectionDetail.entries[1]!.entryId));
  assert.deepEqual(mutations[2], { action: "remove", revision: 7, entryId: collectionDetail.entries[1]!.entryId });
  assert.equal(reloads, 3);
  await view.act(() => view.current.copy());
  assert.deepEqual(copies[0], { title: "Fixture playlist (copy)", sourceCollectionId: collectionDetail.id });
  await view.render({ ...options, source: "spotify" });
  await view.act(() => view.current.copy());
  assert.deepEqual(copies[1], { title: "Fixture playlist (copy)", sourcePlaylistId: collectionDetail.id });
  failure = true;
  await view.act(() => view.current.removePlaylist());
  assert.equal(view.current.error, "Playlist revision changed");
  assert.equal(view.current.busy, false);
  assert.equal(view.current.deleting, false);
  assert.deepEqual(destinations, ["copy", "copy"], "failed deletion never navigates as a success");
  failure = false;
  await view.act(() => view.current.removePlaylist());
  assert.equal(view.current.error, null);
  assert.deepEqual(mutations.at(-1), { action: "delete", revision: 7 });
  assert.equal(destinations.at(-1), "/library");
  await view.unmount();
});
