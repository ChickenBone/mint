import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { jsx } from "react/jsx-runtime";
import { Button, Checkbox, Input, ProgressBar, Row } from "../src/components/ui/primitives";
import { getMenuTargetIndex, getTabTargetIndex, Tabs } from "../src/components/ui/interactive";
import { Shelf } from "../src/components/ui/shelf";
import { ProgressBar as StageProgressBar, StageBadge } from "../src/components/stage-badge";
import { AlbumLink, ArtistLink } from "../src/components/app/music-links";
import { PlaybackControls } from "../src/components/app/player-controls";
import { artistPlayerId, albumPlayerId, type PlayerState } from "../src/lib/player-protocol";

test("buttons expose pending state and retain an accessible action label", () => {
  const html = renderToStaticMarkup(createElement(Button, { loading: true }, "Saving changes"));
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /disabled=""/);
  assert.match(html, />Saving changes<\/button>/);
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
