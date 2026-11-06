import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
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
