import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { jsx } from "react/jsx-runtime";
import { Button, Checkbox, Input, ProgressBar, Row } from "../src/components/ui/primitives";
import { ConfirmDialog } from "../src/components/ui/confirm-dialog";
import { getMenuTargetIndex, getTabTargetIndex, Tabs } from "../src/components/ui/interactive";
import { Shelf } from "../src/components/ui/shelf";
import { ProgressBar as StageProgressBar, StageBadge } from "../src/components/stage-badge";
import { AlbumLink, ArtistLink } from "../src/components/app/music-links";
import { PlaybackControls } from "../src/components/app/player-controls";
import { artistPlayerId, albumPlayerId, type PlayerState } from "../src/lib/player-protocol";
import { SidebarPlaylistLinks } from "../src/components/app/sidebar-nav";
import { Artwork, ArtworkAtmosphere } from "../src/components/artwork";
import { PageHeader } from "../src/components/app/page-header";
import { ExternalRecording, SearchResults } from "../src/components/app/global-search";
import { BridgeAlbumActions } from "../src/components/app/music-browser";
import { uniqueExternalResults } from "../src/lib/unified-search";

const searchSong = { id: "catalog-song", title: "Imaginary Signal", artist: "The Paper Moons", album: "Fictional Nights",
  durationSec: 180, token: "fixture-token", existing: null };
const searchTrack = { id: "library-song", title: "Quiet Orbit", artist: "The Paper Moons", type: "track" as const, duration: 180_000 };
const searchProps = {
  groups: [{ label: "Songs", type: "track" as const, items: [searchTrack] }],
  recordings: [searchSong], requests: {}, playable: {}, filter: "Songs" as const,
  query: "quiet orbit", localLoading: false, offline: false, canPlay: false, playDisabled: false, onPlay: () => undefined,
  onNavigate: () => undefined, onAdd: () => undefined,
};

function renderSearch(element: React.ReactElement) {
  const previousReact = Object.getOwnPropertyDescriptor(globalThis, "React");
  Object.defineProperty(globalThis, "React", { value: React, configurable: true });
  try {
    return renderToStaticMarkup(element);
  } finally {
    if (previousReact) Object.defineProperty(globalThis, "React", previousReact);
    else Reflect.deleteProperty(globalThis, "React");
  }
}

test("search puts library and catalog songs in one compact section with explicit icon actions", () => {
  const html = renderSearch(createElement(SearchResults, searchProps));
  assert.equal((html.match(/<section aria-label="Songs"/g) ?? []).length, 1);
  assert.match(html, /Quiet Orbit/);
  assert.match(html, /Imaginary Signal/);
  assert.doesNotMatch(html, /More songs|divide-y/);
  assert.match(html, /aria-label="Like and add: Imaginary Signal by The Paper Moons"/);
  assert.match(html, /aria-label="Song options: Imaginary Signal"/);
  assert.match(html, /Import without liking/);
  assert.doesNotMatch(html, />Add to library<\/button>/);
  assert.equal((html.match(/group flex min-h-16/g) ?? []).length, 2);
});

test("search type filters hide unrelated result sections", () => {
  for (const filter of ["Artists", "Albums"] as const) {
    const type = filter === "Artists" ? "artist" : "album";
    const html = renderSearch(createElement(SearchResults, {
      ...searchProps, filter,
      groups: [...searchProps.groups, { label: filter, type, items: [{ id: type, type, title: `Fixture ${type}` }] }],
    }));
    assert.match(html, new RegExp(`aria-label="${filter}"`));
    assert.doesNotMatch(html, /aria-label="Songs"|Quiet Orbit|Imaginary Signal|Top result/);
  }
});

test("linked search recordings retain version and duration conflicts but collapse incomplete metadata", () => {
  const linked = { ...searchSong, title: searchTrack.title, album: null, durationSec: null,
    existing: { id: searchTrack.id, recordingId: searchSong.id, stage: "ready" as const, error: null, detail: null, playable: true } };
  const live = { ...linked, title: "Quiet Orbit (Live)" };
  const longer = { ...linked, durationSec: 240 };
  const otherArtist = { ...linked, artist: "Another artist" };
  assert.deepEqual(uniqueExternalResults([searchTrack], [linked]), []);
  for (const conflict of [live, longer, otherArtist]) {
    assert.deepEqual(uniqueExternalResults([searchTrack], [conflict]), [conflict]);
  }
  const html = renderSearch(createElement(SearchResults, { ...searchProps, recordings: uniqueExternalResults([searchTrack], [live]) }));
  assert.match(html, /Quiet Orbit \(Live\)/);
});

test("the relevant catalog recording stays visible while library results load and when Songs is selected", () => {
  const props = { ...searchProps, groups: [], query: "imaginary signal", filter: "All" as const };
  const loading = renderSearch(createElement(SearchResults, { ...props, localLoading: true }));
  assert.doesNotMatch(loading, /aria-label="Top result"/);
  assert.match(loading, /aria-label="Songs"/);
  assert.match(loading, /aria-label="Like and add: Imaginary Signal by The Paper Moons"/);

  const loaded = renderSearch(createElement(SearchResults, { ...props, localLoading: false }));
  assert.match(loaded, /aria-label="Top result"/);
  assert.doesNotMatch(loaded, /aria-label="Songs"/);
  assert.equal((loaded.match(/aria-label="Like and add: Imaginary Signal by The Paper Moons"/g) ?? []).length, 1);
  assert.match(loaded, /Import without liking/);

  const songs = renderSearch(createElement(SearchResults, { ...props, filter: "Songs", localLoading: false }));
  assert.doesNotMatch(songs, /aria-label="Top result"/);
  assert.match(songs, /aria-label="Songs"/);
  assert.match(songs, /aria-label="Like and add: Imaginary Signal by The Paper Moons"/);
});

test("top result ranks library and catalog artists and recordings by the query", () => {
  const artist = { id: "artist", type: "artist" as const, title: "Imaginary Signal Ensemble" };
  const props = { ...searchProps, query: "imaginary signal", filter: "All" as const,
    groups: [...searchProps.groups, { label: "Artists", type: "artist" as const, items: [artist] }] };
  const recordingTop = renderSearch(createElement(SearchResults, props));
  assert.match(recordingTop, /aria-label="Top result"[\s\S]*?Imaginary Signal/);
  assert.equal((recordingTop.match(/aria-label="Like and add: Imaginary Signal by The Paper Moons"/g) ?? []).length, 1);

  const artistTop = renderSearch(createElement(SearchResults, { ...props, query: "fictional ensemble", recordings: [],
    catalogArtists: [{ id: "catalog-artist", name: "Fictional Ensemble" }] }));
  assert.match(artistTop, /aria-label="Top result"[\s\S]*?href="\/app\/library\/artists\/catalog-artist"/);
  assert.match(artistTop, /Fictional Ensemble/);
});

test("album cards attach bridge actions only for a verified release-group ID", () => {
  const item = (id: string, title: string) => ({ id, title, artist: "Fixture artist",
    source: "musicbrainz" as const, playable: false as const, url: `https://musicbrainz.org/release-group/${id}` });
  const first = item("00000000-0000-4000-8000-000000000001", "Fixture album");
  const second = item("00000000-0000-4000-8000-000000000002", "Fixture album");
  const live = item("00000000-0000-4000-8000-000000000003", "Fixture album (Live)");
  const album = { title: first.title, artist: first.artist };
  assert.equal(renderSearch(createElement(BridgeAlbumActions, { album, items: [first, second, live], onSelect: () => undefined })), "");
  assert.equal(renderSearch(createElement(BridgeAlbumActions, {
    album: { ...album, verifiedReleaseGroupId: first.id }, items: [second], onSelect: () => undefined,
  })), "");
  const html = renderSearch(createElement(BridgeAlbumActions, { album: { ...album, verifiedReleaseGroupId: second.id }, items: [first, second, live],
    selectedId: second.id, onSelect: () => undefined }));
  assert.match(html, /aria-label="Browse catalog recordings for Fixture album" aria-expanded="true"/);
  assert.equal((html.match(/<button/g) ?? []).length, 1);
});

test("catalog song rows keep processing, retry and playable states honest", () => {
  const props = { item: searchSong, busy: false, playDisabled: false, onPlay: () => undefined, onAdd: () => undefined };
  const processing = renderSearch(createElement(ExternalRecording, {
    ...props, request: { trackId: "requested", stage: "matching", progress: 0.5, error: null },
  }));
  assert.match(processing, /Adding · 50%/);
  assert.match(processing, /aria-label="Adding Imaginary Signal"/);
  assert.doesNotMatch(processing, /aria-label="Like and add:|aria-label="Play /);
  assert.match(processing, /aria-label="Like Imaginary Signal by The Paper Moons"/);
  const liked = renderSearch(createElement(ExternalRecording, {
    ...props, request: { trackId: "requested", stage: "queued", progress: 0, error: null, liked: true },
  }));
  assert.match(liked, /aria-label="Liked Imaginary Signal"/);
  const failed = renderSearch(createElement(ExternalRecording, {
    ...props, request: { trackId: "requested", stage: "failed", progress: 0, error: "Failed" },
  }));
  assert.match(failed, /role="alert"/);
  assert.match(failed, /aria-label="Retry adding Imaginary Signal by The Paper Moons"/);
  const ready = renderSearch(createElement(ExternalRecording, { ...props, playable: searchTrack }));
  assert.match(ready, /aria-label="Play Imaginary Signal"/);
  assert.doesNotMatch(ready, /aria-label="Like and add:|aria-label="Adding /);
  const offline = renderSearch(createElement(ExternalRecording, { ...props, busy: true }));
  assert.match(offline, /<button[^>]*disabled=""[^>]*aria-label="Like and add:/);
});

test("sidebar playlists keep native, smart and collaborative links accessible in the compact rail", () => {
  const playlists = [
    { id: "native", title: "Evening drives", artworkUrl: null, smart: false, role: "owner" as const, pinned: true },
    { id: "shared", title: "Shared & very long playlist title", artworkUrl: null, smart: false, role: "editor" as const, pinned: false },
    { id: "smart", title: "Fresh finds", artworkUrl: null, smart: true, role: "owner" as const, pinned: false },
  ];
  const html = renderToStaticMarkup(createElement(SidebarPlaylistLinks, { playlists, path: "/app/collection/shared" }));
  assert.match(html, /aria-label="Mint playlists"/);
  assert.match(html, /<a[^>]*aria-label="Evening drives"[^>]*href="\/app\/collection\/native"/);
  assert.match(html, /<a[^>]*aria-current="page"[^>]*href="\/app\/collection\/shared"/);
  assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
  assert.match(html, /Collaborative playlist/);
  assert.match(html, /Smart playlist/);
  assert.match(html, /Pinned\./);
  assert.match(html, /truncate/);
  assert.match(html, /min-h-14/);
  assert.match(html, /lg:block/);
  const changed = renderToStaticMarkup(createElement(SidebarPlaylistLinks, {
    playlists: [{ ...playlists[0]!, title: "UX actions" }], path: "/app/collection/native",
  }));
  assert.match(changed, /aria-label="UX actions"/);
  assert.doesNotMatch(changed, /Evening drives|Collaborative playlist/);
});

test("buttons expose pending state and retain an accessible action label", () => {
  const html = renderToStaticMarkup(createElement(Button, { loading: true }, "Saving changes"));
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /disabled=""/);
  assert.match(html, />Saving changes<\/button>/);
});

test("artwork atmosphere is decorative, privacy-preserving and safe without a cover", () => {
  const html = renderToStaticMarkup(createElement(ArtworkAtmosphere, { src: "/api/artwork/fictional" }));
  assert.match(html, /class="artwork-atmosphere" aria-hidden="true"/);
  assert.match(html, /src="\/api\/artwork\/fictional"/);
  assert.match(html, /alt=""/);
  assert.match(html, /referrerPolicy="no-referrer"/i);
  assert.doesNotMatch(renderToStaticMarkup(createElement(ArtworkAtmosphere)), /<img/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(Artwork, { track: { artworkUrl: "" } })), /<img/);
});

test("page headings opt into artwork without changing actions or neutral headings", () => {
  const html = renderToStaticMarkup(createElement(PageHeader, {
    title: "Fictional playlist", backdrop: "/api/artwork/fictional",
  }, createElement(Button, { variant: "primary" }, "Play")));
  assert.match(html, /music-atmosphere/);
  assert.match(html, /artwork-atmosphere/);
  assert.match(html, /ui-primary/);
  assert.match(html, />Play<\/button>/);
  const neutral = renderToStaticMarkup(createElement(PageHeader, { title: "Settings" }));
  assert.doesNotMatch(neutral, /artwork-atmosphere|music-atmosphere/);
});

test("inputs associate their visible label and error with the field", () => {
  const html = renderToStaticMarkup(
    createElement(Input, { label: "Email address", name: "email", type: "email", error: "Enter a valid email address." }),
  );
  assert.match(html, /<label[^>]*>Email address<\/label>/);
  assert.match(html, /name="email"/);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /Enter a valid email address\./);
  assert.match(html, /aria-describedby="[^"]+-error"/);
});

test("checkboxes and tabs expose state in accessible semantics", () => {
  const checkbox = renderToStaticMarkup(createElement(Checkbox, { label: "Keep me signed in", name: "remember" }));
  const tabs = renderToStaticMarkup(
    createElement(Tabs, {
      label: "Now Playing sections",
      value: "queue",
      onValueChange: () => undefined,
      tabs: [
        { value: "queue", label: "Queue", content: "Upcoming songs" },
        { value: "lyrics", label: "Lyrics", content: "Song words" },
      ],
    }),
  );
  assert.match(checkbox, /type="checkbox"/);
  assert.match(checkbox, /Keep me signed in/);
  assert.match(tabs, /role="tablist" aria-label="Now Playing sections"/);
  assert.match(tabs, /role="tab"[^>]*aria-selected="true"/);
  assert.match(tabs, /role="tabpanel"/);
  assert.match(tabs, /hidden=""/);
  assert.match(tabs, /overflow-x-auto/);
  assert.match(tabs, /shrink-0/);
});

test("progress and ranked rows retain numeric and textual state", () => {
  const progress = renderToStaticMarkup(createElement(ProgressBar, { label: "Download progress", value: 140, max: 100 }));
  const row = renderToStaticMarkup(jsx(Row, { rank: 3, status: "Not available", children: "Track title" }));
  assert.match(progress, /aria-valuenow="100"/);
  assert.match(progress, /width:100%/);
  assert.match(row, /Rank 3\./);
  assert.match(row, /Not available/);
});

test("shelves are named, focusable horizontal regions", () => {
  const html = renderToStaticMarkup(jsx(Shelf, { label: "Recently added", children: jsx("li", { children: "Album" }) }));
  assert.match(html, /role="region"/);
  assert.match(html, /aria-label="Recently added"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /overflow-x-auto/);
});

test("tab and menu keyboard navigation wraps and skips disabled items", () => {
  const items = [{}, { disabled: true }, {}, {}];
  assert.equal(getTabTargetIndex(items, 0, "ArrowRight"), 2);
  assert.equal(getTabTargetIndex(items, 2, "ArrowLeft"), 0);
  assert.equal(getTabTargetIndex(items, 0, "End"), 3);
  assert.equal(getMenuTargetIndex(items, -1, "ArrowDown"), 0);
  assert.equal(getMenuTargetIndex(items, 0, "ArrowDown"), 2);
  assert.equal(getMenuTargetIndex(items, 2, "ArrowUp"), 0);
  assert.equal(getMenuTargetIndex(items, 3, "Home"), 0);
  assert.equal(getMenuTargetIndex(items, 3, "Escape"), undefined);
});

test("track stages and processing progress compose shared status primitives", () => {
  const stage = renderToStaticMarkup(createElement(StageBadge, { stage: "ready" }));
  const progress = renderToStaticMarkup(createElement(StageProgressBar, { value: 0.5 }));
  assert.match(stage, /Ready/);
  assert.match(progress, /aria-label="Processing progress"/);
  assert.match(progress, /aria-valuenow="50"/);
});

test("artist and album names are separate canonical navigation links, including Unicode identities", () => {
  const item = { artist: "Fixture ñ / artist", album: "Test album & one" };
  const artist = renderToStaticMarkup(createElement(ArtistLink, { item }));
  const album = renderToStaticMarkup(createElement(AlbumLink, { item }));
  assert.ok(artist.includes(`/app/library/artists/${artistPlayerId(item.artist)}?type=album`));
  assert.ok(album.includes(`/app/library/albums/${albumPlayerId(item.artist, item.album)}?type=track`));
  const explicit = renderToStaticMarkup(createElement(ArtistLink, { item: { ...item, artistId: "ar_explicit" } }));
  assert.match(explicit, /artists\/ar_explicit/);
  assert.equal(renderToStaticMarkup(createElement(ArtistLink, { item: {} })), "");
  assert.equal(renderToStaticMarkup(createElement(AlbumLink, { item: {} })), "Single");
});

test("compact and expanded transport preserve playback, shuffle and repeat semantics", () => {
  const state: PlayerState = { playing: true, track: { id: "fixture", title: "Test song", type: "track" }, time: 0, duration: 1000,
    volume: 100, shuffle: true, repeat: 1, queue: [], queueTotal: 0, queueOffset: 0 };
  for (const expanded of [false, true]) {
    const html = renderToStaticMarkup(createElement(PlaybackControls, { state, ready: true, command: () => undefined, expanded }));
    assert.match(html, /aria-label="Pause"/);
    assert.match(html, /aria-label="Shuffle"[^>]*aria-pressed="true"/);
    assert.match(html, /aria-label="Repeat one"[^>]*aria-pressed="true"/);
    assert.match(html, /aria-label="Previous track"/);
    assert.match(html, /aria-label="Next track"/);
  }
});

test("ConfirmDialog renders an accessible modal dialog for destructive actions", () => {
  const html = renderToStaticMarkup(
    createElement(ConfirmDialog, {
      open: true,
      onClose: () => undefined,
      onConfirm: () => undefined,
      title: "Delete playlist?",
      description: "Delete Night Drive? Your songs remain in the library.",
      confirmLabel: "Delete playlist",
      tone: "danger",
    }),
  );
  assert.match(html, /<dialog[^>]*aria-labelledby="/);
  assert.match(html, /Delete playlist\?/);
  assert.match(html, /Delete Night Drive\? Your songs remain in the library\./);
  assert.match(html, />Cancel<\/button>/);
  assert.match(html, />Delete playlist<\/button>/);
});
