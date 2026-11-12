import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { CatalogBridge, CatalogBridgeError, catalogMbidSchema, configuredCatalogBridge } from "@mint/core";
import { verifyToken } from "@mint/core/crypto";
import { PLAYABLE } from "@mint/core/playback";
import { albumPlayerId, externalCatalogPageSchema, MintApi } from "@mint/client";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { catalogPageForListener, decodeCatalogLibraryAlbum } from "../src/lib/catalog-connection-data";
import { catalogQueryMatches, sameCatalogAlbum, visibleBridgeItems } from "../src/components/app/catalog-artist-albums";
import { nativeHttp } from "../src/lib/native-http";
import { readRequestRecording } from "../src/lib/music-requests";

const id = "00000000-0000-4000-8000-000000000001";
const user = { id: "fixture-user", name: "Fixture listener", email: "fixture@example.invalid", role: "user" as const, status: "active" as const };
test("album presentations match only a verified release-group ID, not names", () => {
  const album = { title: "Café Lights", artist: "The Paper Moons" };
  const item = (itemId: string, title: string, artist = album.artist) => ({
    id: itemId, title, artist, source: "musicbrainz" as const, playable: false as const,
    url: `https://musicbrainz.org/release-group/${itemId}`,
  });
  const main = item(id, "Cafe Lights");
  const sameName = item("00000000-0000-4000-8000-000000000002", "Cafe Lights");
  const live = item("00000000-0000-4000-8000-000000000003", "Cafe Lights (Live)");
  const verified = { ...album, verifiedReleaseGroupId: id };
  const renamed = { ...main, title: "Different title" };
  assert.equal(sameCatalogAlbum(main, album), false);
  assert.equal(sameCatalogAlbum(main, verified), true);
  assert.equal(sameCatalogAlbum(renamed, verified), true);
  assert.equal(sameCatalogAlbum(sameName, verified), false);
  assert.equal(sameCatalogAlbum({ ...main, url: `https://musicbrainz.org/recording/${id}` }, verified), false);
  assert.deepEqual(visibleBridgeItems([main, sameName, live], "artists", "", [album], []), [main, sameName, live]);
  assert.deepEqual(visibleBridgeItems([main, sameName, live], "artists", "", [verified], []), [sameName, live]);
  assert.deepEqual(visibleBridgeItems([main, sameName, live], "artists", "live", [verified], []), [live]);
});

test("bridge recordings dedupe by recording ID, retaining same-title versions and search filtering", () => {
  const item = (itemId: string, title: string) => ({
    id: itemId, title, artist: "Fixture artist", source: "musicbrainz" as const, playable: false as const,
    url: `https://musicbrainz.org/recording/${itemId}`, requestToken: "fixture-token",
  });
  const shared = item(id, "Fixture song");
  const alternate = item("00000000-0000-4000-8000-000000000002", "Fixture song");
  const live = item("00000000-0000-4000-8000-000000000003", "Fixture song (Live)");
  assert.deepEqual(visibleBridgeItems([shared, alternate, live], "library-albums", "", [], [id]), [alternate, live]);
  assert.deepEqual(visibleBridgeItems([shared, alternate, live], "library-albums", "live", [], [id]), [live]);
});

test("artist Albums and Songs keep both catalog sources in their appropriate views", () => {
  const require = createRequire(import.meta.url);
  const source = readFileSync(new URL("../src/components/app/music-browser.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const collection = { kind: "artist" as const, id: "ar_fixture" };
  const profile = { status: "ready", musicBrainzArtistId: id, profile: null };
  const localAlbum = { id: "local-album", type: "album", title: "Shared album", artist: "Fixture artist" };
  const localSong = { id: "local-song", type: "track", title: "Library song", artist: "Fixture artist" };
  const catalogAlbum = { id: "catalog-album", title: "Catalog album", artist: "Fixture artist" };
  const catalogSong = { id: "catalog-song", title: "Catalog song" };
  const bridge = (itemId: string, title: string) => ({ id: itemId, title, artist: "Fixture artist",
    source: "musicbrainz" as const, playable: false as const, url: `https://musicbrainz.org/release-group/${itemId}` });
  const bridgeAlbums = [bridge(id, "Shared album"), bridge("00000000-0000-4000-8000-000000000002", "Catalog album"),
    bridge("00000000-0000-4000-8000-000000000003", "Bridge-only album")];
  const collectionParams = () => new URLSearchParams({ kind: "artist", id: collection.id });
  const render = (type: "album" | "track") => {
    const params = new URLSearchParams({ type });
    const query = collectionParams();
    query.set("type", type); query.set("sort", "artist"); query.set("size", "100"); query.set("start", "0");
    const states: unknown[] = [
      { key: query.toString(), page: { items: [type === "album" ? localAlbum : localSong], total: 1, start: 0 } },
      0, { key: collectionParams().toString(), page: { items: [], total: 1, title: "Fixture artist", artistProfile: profile } },
      null, { artistMbid: id, items: bridgeAlbums }, null,
    ];
    let hook = 0;
    const hooks = { ...React, useEffect() {}, useCallback: (callback: unknown) => callback, useSyncExternalStore: () => true,
      useState(initial: unknown) { return [hook < states.length ? states[hook++] : initial, () => {}]; } };
    const Link = ({ href, children, ...props }: { href: string; children?: React.ReactNode }) =>
      React.createElement("a", { ...props, href }, children);
    const player = { ready: true, busy: false, state: { track: null }, command() {} };
    const modules: Record<string, unknown> = {
      react: hooks,
      "next/link": { default: Link },
      "next/navigation": { usePathname: () => "/app/library/artists/ar_fixture", useRouter: () => ({ replace() {} }), useSearchParams: () => params },
      "@/components/artwork": { Artwork: () => null, ArtworkAtmosphere: () => null },
      "@/lib/player-protocol": { artistPlayerId: () => "ar_fixture", collectionIdentity: () => ({ artist: "Fixture artist" }) },
      "@/lib/browser-catalog": { collectionParams, collectionFromParams: () => ({ success: true, data: collection }), metadataFilterKeys: [] },
      "@/lib/format": { formatDuration: () => "3:00" },
      "./collection-actions": { CollectionActions: () => null },
      "./catalog-collection-songs": {
        catalogQueryMatches, useCatalogCollection: () => ({ data: { items: [catalogSong], albums: [catalogAlbum] }, loading: false }),
        CatalogCollectionRows: ({ items }: { items: typeof catalogSong[] }) =>
          React.createElement("ul", { "aria-label": "Songs not imported yet" }, items.map((item) => React.createElement("li", { key: item.id }, item.title))),
        CatalogAlbumCards: ({ albums, renderActions }: { albums: typeof catalogAlbum[]; renderActions?: (album: typeof catalogAlbum) => React.ReactNode }) =>
          React.createElement(React.Fragment, null, albums.map((album) =>
            React.createElement("article", { key: album.id }, album.title, renderActions?.(album)))),
      },
      "./catalog-artist-albums": {
        sameCatalogAlbum,
        CatalogArtistAlbums: (props: { query?: string; displayedAlbums?: { title: string; artist: string }[] }) =>
          React.createElement("section", { "aria-label": "Catalog albums" },
            visibleBridgeItems(bridgeAlbums, "artists", props.query ?? "", props.displayedAlbums ?? [], [])
              .map((item) => React.createElement("span", { key: item.id }, item.title))),
        CatalogLibraryAlbum: () => null,
      },
      "./player": { usePlayer: () => player, TrackMenuButton: () => null },
      "./music-links": { ArtistLink: ({ item }: { item: { artist?: string } }) => item.artist, AlbumLink: () => null },
      "./music-item": { MusicItem: ({ as = "div", item: _item, children, ...props }: {
        as?: string; item?: unknown; children?: React.ReactNode;
      }) => React.createElement(as, props, children) },
    };
    const exports: { MusicBrowser?: typeof import("../src/components/app/music-browser").MusicBrowser } = {};
    new Function("require", "exports", compiled)((name: string) => name in modules ? modules[name] : require(name), exports);
    assert.ok(exports.MusicBrowser);
    return renderToStaticMarkup(React.createElement(exports.MusicBrowser, { initialCollection: collection }));
  };
  const albums = render("album");
  assert.match(albums, /aria-pressed="true"[^>]*>Albums<\/button>/);
  assert.doesNotMatch(albums, /Browse catalog recordings for (Shared|Catalog) album/);
  assert.match(albums, /aria-label="Catalog albums"><span>Shared album<\/span><span>Catalog album<\/span><span>Bridge-only album<\/span>/);
  const songs = render("track");
  assert.match(songs, /aria-pressed="true"[^>]*>Songs<\/button>/);
  assert.match(songs, /Library song/);
  assert.match(songs, /Catalog song/);
  assert.doesNotMatch(songs, /aria-label="Catalog albums"|Bridge-only album/);
});

test("the collection search retains partial results while reporting an unconfigured or unavailable search catalog", async () => {
  const require = createRequire(import.meta.url);
  const source = readFileSync(new URL("../src/components/app/catalog-collection-songs.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const originalFetch = globalThis.fetch;
  try {
    for (const [status, message] of [
      ["not_configured", /not configured/],
      ["unavailable", /unavailable/],
    ] as const) {
      globalThis.fetch = async () => Response.json({
        items: [{ id: "fixture-recording" }], albums: [], catalog: { status },
      });
      let hook = 0;
      let resolveUpdate!: (state: { data?: { items: { id: string }[] }; error?: string }) => void;
      const updated = new Promise<{ data?: { items: { id: string }[] }; error?: string }>((resolve) => { resolveUpdate = resolve; });
      const hooks = { ...React, useEffect(effect: () => void) { effect(); }, useState(initial: unknown) {
        return [initial, hook++ === 0 ? resolveUpdate : () => {}];
      } };
      const exports: { useCatalogCollection?: typeof import("../src/components/app/catalog-collection-songs").useCatalogCollection } = {};
      new Function("require", "exports", compiled)((name: string) => {
        if (name === "react") return hooks;
        if (name === "./catalog-artist-albums") return { catalogQueryMatches: () => true };
        if (name.startsWith("@/") || name === "./global-search" || name === "./player") return {};
        return require(name);
      }, exports);
      assert.ok(exports.useCatalogCollection);
      assert.equal(exports.useCatalogCollection("al_fixture").loading, true);
      const state = await updated;
      assert.deepEqual(state.data?.items, [{ id: "fixture-recording" }]);
      assert.match(state.error ?? "", message);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the entire artist catalog shelf disappears when disabled or unverified, retaining loading and error feedback", () => {
  const require = createRequire(import.meta.url);
  const source = readFileSync(new URL("../src/components/app/catalog-artist-albums.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const cases = [
    { page: { configured: false, items: [], nextCursor: null }, hidden: true },
    { page: { configured: true, identityVerified: false, items: [], nextCursor: null }, hidden: true },
    { page: { configured: true, items: [], nextCursor: null }, hidden: false },
    { error: "Fixture catalog unavailable", hidden: false },
    { loading: true, hidden: false },
  ];
  for (const fixture of cases) {
    let hook = 0;
    const hooks = {
      ...React,
      useEffect() {},
      useState(initial: unknown) {
        return [hook++ === 3 ? fixture.loading ? null : { after: null, revision: 0, ...fixture } : initial, () => {}];
      },
    };
    const exports: { CatalogArtistAlbums?: typeof import("../src/components/app/catalog-artist-albums").CatalogArtistAlbums } = {};
    new Function("require", "exports", compiled)((name: string) => name === "react" ? hooks : require(name), exports);
    assert.ok(exports.CatalogArtistAlbums);
    const html = renderToStaticMarkup(React.createElement(exports.CatalogArtistAlbums, { artistMbid: id }));
    if (fixture.hidden) assert.equal(html, "", "disabled shelves leave no heading, spacing or controls");
    else {
      assert.match(html, /Beyond your library/);
      if (fixture.loading) assert.match(html, /Loading catalog/);
      if (fixture.error) {
        assert.match(html, /Fixture catalog unavailable/);
        assert.match(html, /Try again/);
      }
    }
  }
});

test("the rendered bridge omits represented recordings but keeps distinct requestable recordings", () => {
  const require = createRequire(import.meta.url);
  const source = readFileSync(new URL("../src/components/app/catalog-artist-albums.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const otherId = "00000000-0000-4000-8000-000000000002";
  const items = [{ id, title: "Shared song", artist: "Fixture artist" }, { id: otherId, title: "Live version", artist: "Fixture artist" }]
    .map((item) => ({ ...item, source: "musicbrainz", playable: false, requestToken: "fixture-token",
      url: `https://musicbrainz.org/recording/${item.id}` }));
  const render = (recordingIds: string[], query = "") => {
    let hook = 0;
    const hooks = { ...React, useEffect() {}, useState(initial: unknown) {
      return [hook++ === 2 ? { after: null, revision: 0, page: { configured: true, items, nextCursor: null } } : initial, () => {}];
    } };
    const exports: { CatalogLibraryAlbum?: typeof import("../src/components/app/catalog-artist-albums").CatalogLibraryAlbum } = {};
    new Function("require", "exports", compiled)((name: string) => name === "react" ? hooks : require(name), exports);
    assert.ok(exports.CatalogLibraryAlbum);
    return renderToStaticMarkup(React.createElement(exports.CatalogLibraryAlbum, { albumId: "al_fixture", recordingIds, query }));
  };
  const html = render([id]);
  assert.doesNotMatch(html, /Shared song/);
  assert.match(html, /Live version/);
  assert.match(html, /Add to library/);
  assert.doesNotMatch(render([id], "shared"), /Live version/);
  assert.equal(render([id, otherId]), "");
});

test("an empty filtered library-album page keeps its continuation visible", () => {
  const require = createRequire(import.meta.url);
  const source = readFileSync(new URL("../src/components/app/catalog-artist-albums.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let hook = 0;
  const hooks = { ...React, useEffect() {}, useState(initial: unknown) {
    return [hook++ === 2 ? { after: null, revision: 0, page: { configured: true, items: [], nextCursor: id } } : initial, () => {}];
  } };
  const exports: { CatalogLibraryAlbum?: typeof import("../src/components/app/catalog-artist-albums").CatalogLibraryAlbum } = {};
  new Function("require", "exports", compiled)((name: string) => name === "react" ? hooks : require(name), exports);
  assert.ok(exports.CatalogLibraryAlbum);
  const html = renderToStaticMarkup(React.createElement(exports.CatalogLibraryAlbum, { albumId: "al_fixture" }));
  assert.match(html, /No additional catalog recordings on this page/);
  assert.match(html, /More recordings/);
});

test("local album links are decoded canonically without inferring an external identity from names", () => {
  assert.deepEqual(decodeCatalogLibraryAlbum(albumPlayerId("Fixture artist", "Fixture album")), ["Fixture artist", "Fixture album"]);
  for (const bad of ["artist name", `al_${Buffer.from('["artist"]').toString("base64url")}`,
    `al_${Buffer.from('["artist","album", "extra"]').toString("base64url")}`, `${albumPlayerId("artist", "album")}=`, "al_invalid"]) {
    assert.equal(decodeCatalogLibraryAlbum(bad), null);
  }
});

test("verified library album filters only playable exact recording IDs and preserves upstream cursors", async () => {
  const require = createRequire(import.meta.url);
  const source = readFileSync(new URL("../src/lib/catalog-connection.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const release = "11111111-1111-4111-8111-111111111111";
  const ids = ["a", "b", "c", "d", "e", "f", "f"].map((char, index) =>
    `${char.repeat(8)}-${char.repeat(4)}-4${char.repeat(3)}-8${char.repeat(3)}-${String(index).padStart(12, char)}`);
  const items = ids.map((recordingId) => ({
    id: recordingId, title: "Same title", artist: "Fixture artist", url: `https://musicbrainz.org/recording/${recordingId}`,
  }));
  const tracks = [
    { artist: "Fixture artist", album: "Fixture album", recordingId: ids[0]!.toUpperCase(), stage: "ready", file: true },
    { artist: "Fixture artist", album: "Another album", recordingId: ids[2], stage: "ready", file: true },
    { artist: "Fixture artist", album: "Fixture album", recordingId: ids[3], stage: "queued", file: true },
    { artist: "Fixture artist", album: "Fixture album", recordingId: ids[4], stage: "ready", file: false },
    { artist: "Another artist", album: "Fixture album", recordingId: ids[5], stage: "ready", file: true },
    { artist: "Fixture artist", album: "Fixture album", recordingId: ids[6], stage: "analyzing", file: true },
  ];
  let releases = [{ id: release }];
  let page = { items, next_cursor: ids[6] as string | null };
  const queries: { sql: string; params: unknown[] }[] = [];
  const calls: { kind: string; parent: string; after: string | null; limit: number }[] = [];
  const dialect = new PgDialect();
  const db = { execute: async (statement: SQL) => {
    const query = dialect.sqlToQuery(statement);
    queries.push(query);
    if (query.sql.includes("mb_release_group_id")) return { rows: releases };
    assert.match(query.sql, /artist\s*=\s*\$1/);
    assert.match(query.sql, /coalesce\(album, ''\)\s*=\s*\$2/);
    assert.match(query.sql, /"stage" in \(\$3, \$4\)/);
    assert.match(query.sql, /"file_path" is not null or "tracks"\."existing_file_path" is not null/);
    assert.match(query.sql, /lower\(mb_recording_id\) in \(/);
    assert.match(query.sql, /limit \$\d+/);
    const [artist, album, ...rest] = query.params;
    const stages = rest.slice(0, 2), candidates = rest.slice(2, -1), limit = rest.at(-1);
    assert.deepEqual(stages, ["ready", "analyzing"]);
    assert.equal(limit, page.items.length);
    assert.deepEqual(candidates, page.items.map((item) => item.id));
    return { rows: tracks.filter((track) => track.artist === artist && (track.album ?? "") === album &&
      stages.includes(track.stage) && track.file && track.recordingId && candidates.includes(track.recordingId.toLowerCase()))
      .map((track) => ({ id: track.recordingId!.toLowerCase() })) };
  } };
  const bridge = { page: async (kind: string, parent: string, after: string | null, limit: number) => {
    calls.push({ kind, parent, after, limit });
    return page;
  } };
  const modules: Record<string, unknown> = {
    "@mint/core": { CatalogBridgeError, catalogMbidSchema, configuredCatalogBridge: () => bridge },
    "@mint/core/db": { getDb: () => db },
    "@mint/core/playback": { PLAYABLE },
    "./auth": { getUser: async () => user },
    "./rate-limit": { rateLimit: async () => true },
    "./catalog-connection-data": { catalogPageForListener, decodeCatalogLibraryAlbum },
  };
  const exports: { catalogConnectionResponse?: typeof import("../src/lib/catalog-connection").catalogConnectionResponse } = {};
  new Function("require", "exports", compiled)((name: string) => name in modules ? modules[name] : require(name), exports);
  assert.ok(exports.catalogConnectionResponse);
  const handle = exports.catalogConnectionResponse;
  const album = albumPlayerId("Fixture artist", "Fixture album");
  const path = ["catalog", "library-albums", album, "recordings"];
  const request = (suffix = "") => new Request(`https://mint.example.invalid/api/catalog/library-albums/${album}/recordings${suffix}`);
  const original = process.env.MINT_SIGNING_SECRET;
  process.env.MINT_SIGNING_SECRET = "fixture-not-a-real-signing-secret-1234567890";
  try {
    const response = await handle(request("?limit=7"), path);
    assert.equal(response.status, 200);
    const result = externalCatalogPageSchema.parse(await response.json());
    assert.deepEqual(result.items.map((item) => item.id), ids.slice(1, 6), "different IDs and nonplayable or other-album tracks remain");
    assert.equal(result.nextCursor, ids[6], "cursor remains the last upstream item even when that item was filtered");
    assert.deepEqual(calls[0], { kind: "albums", parent: release, after: null, limit: 7 });
    assert.equal(queries.length, 2, "one bounded recording lookup follows album verification, not one lookup per row");
    assert.deepEqual(queries[1]?.params.slice(0, 2), ["Fixture artist", "Fixture album"]);
    assert.equal(readRequestRecording(user.id, result.items[0]!.requestToken!).id, ids[1]);

    queries.length = 0;
    page = { items: [items[0]!], next_cursor: ids[0]! };
    const empty = externalCatalogPageSchema.parse(await (await handle(request(), path)).json());
    assert.deepEqual(empty.items, []);
    assert.equal(empty.nextCursor, ids[0], "an entirely filtered page still exposes its continuation");
    assert.equal(queries.length, 2);

    queries.length = 0;
    releases = [{ id: release }, { id: id }];
    const callCount = calls.length;
    const unverified = externalCatalogPageSchema.parse(await (await handle(request(), path)).json());
    assert.deepEqual(unverified, { configured: true, identityVerified: false, items: [], nextCursor: null });
    assert.equal(calls.length, callCount);
    assert.equal(queries.length, 1);

    queries.length = 0;
    page = { items: [items[0]!], next_cursor: null };
    const direct = externalCatalogPageSchema.parse(await (await handle(
      new Request(`https://mint.example.invalid/api/catalog/albums/${release}/recordings`),
      ["catalog", "albums", release, "recordings"],
    )).json());
    assert.equal(direct.items[0]?.id, ids[0], "non-library bridge reads are unchanged");
    assert.equal(queries.length, 0);
  } finally {
    if (original === undefined) delete process.env.MINT_SIGNING_SECRET; else process.env.MINT_SIGNING_SECRET = original;
  }
});

test("catalog recordings become non-playable metadata and account/purpose-bound explicit request choices", async () => {
  const original = process.env.MINT_SIGNING_SECRET;
  process.env.MINT_SIGNING_SECRET = "fixture-not-a-real-signing-secret-1234567890";
  try {
    const bridge = new CatalogBridge("https://example.invalid", "fixture-not-a-real-bridge-token-123456", async () =>
      Response.json({ items: [{ id, title: "Fixture recording", artist: "Fixture artist", url: `https://musicbrainz.org/recording/${id}` }], next_cursor: null }));
    const raw = await bridge.page("albums", id);
    const result = catalogPageForListener(raw, user.id, "albums");
    const [recording] = result.items;
    assert.equal(recording?.playable, false);
    assert.equal(recording?.source, "musicbrainz");
    assert.equal(recording?.requestToken?.includes("fixture-not-a-real-bridge-token"), false);
    assert.deepEqual(readRequestRecording(user.id, recording!.requestToken!), {
      id, title: "Fixture recording", artist: "Fixture artist", album: null, durationSec: null,
    });
    assert.throws(() => readRequestRecording("another-fixture-user", recording!.requestToken!), /expired/);
    assert.equal(verifyToken("audio", recording!.requestToken), null);
    const albums = catalogPageForListener({ items: [{ id, title: "Fixture album", artist: "Fixture artist", url: `https://musicbrainz.org/release-group/${id}` }], next_cursor: null }, user.id, "artists");
    assert.equal(albums.items[0]?.requestToken, undefined, "album browsing does not create album acquisition permission");
    assert.equal(externalCatalogPageSchema.safeParse({ ...result, items: [{ ...recording, playable: true }] }).success, false);

    const calls: string[] = [];
    const api = new MintApi({ serverUrl: "https://mint.example.invalid", token: `mn1.${id}.${"a".repeat(43)}`,
      fetch: async (url, init) => {
        calls.push(String(url));
        assert.equal(new Headers(init?.headers).get("authorization"), `Bearer mn1.${id}.${"a".repeat(43)}`);
        return Response.json(result);
      } });
    const page = await api.request(`catalog/albums/${id}/recordings?limit=50`, externalCatalogPageSchema);
    assert.equal(page.items[0]?.playable, false);
    assert.equal(calls.length, 1, "browsing performs a single metadata GET, never an acquisition or queue request");
  } finally {
    if (original === undefined) delete process.env.MINT_SIGNING_SECRET;
    else process.env.MINT_SIGNING_SECRET = original;
  }
});

test("unconfigured catalog fallback stays separate from playable data and privately transported", async () => {
  assert.equal(configuredCatalogBridge({}), null);
  const request = new Request(`https://mint.example.invalid/api/native/catalog/artists/${id}/albums`);
  const response = await nativeHttp(request, async () =>
    Response.json(externalCatalogPageSchema.parse({ configured: false, items: [], nextCursor: null })));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { configured: false, items: [], nextCursor: null });
  assert.equal(externalCatalogPageSchema.safeParse({ configured: false, items: [{
    id, title: "Fixture", artist: "Fixture", source: "musicbrainz", playable: false,
    url: `https://musicbrainz.org/recording/${id}`,
  }], nextCursor: null }).success, false);
});
