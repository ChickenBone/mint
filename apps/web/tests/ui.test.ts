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
import { SetupNudge } from "../src/components/app/setup-nudge";

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

test("SetupNudge renders first-run welcome steps and linked playable progress", () => {
  const unlinkedHtml = renderToStaticMarkup(createElement(SetupNudge, { linked: false }));
  assert.match(unlinkedHtml, /Welcome to your listening room/);
  assert.match(unlinkedHtml, /1\. Connect a source/);
  assert.match(unlinkedHtml, /2\. Explore the library/);
  assert.match(unlinkedHtml, /3\. Play &amp; discover/);

  const linkedHtml = renderToStaticMarkup(
    createElement(SetupNudge, {
      linked: true,
      summary: { total: 4, ready: 2, active: 1, failed: 1 },
    }),
  );
  assert.match(linkedHtml, /Bringing in your music/);
  assert.match(linkedHtml, /2 of 4 playable/);
  assert.match(linkedHtml, /aria-valuenow="50"/);
});
