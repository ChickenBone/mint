import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptsListeningEvent, ListeningHistoryInputError } from "../src/history-policy";

const now = new Date("2025-01-01T00:00:00.000Z");
const boundary = new Date("2024-12-31T23:59:00.000Z");

test("history policy keeps the one-second threshold and private-session boundary", () => {
  assert.equal(acceptsListeningEvent({
    privateSession: false, listenedMs: 999, historyAfter: null, now,
  }), false);
  assert.equal(acceptsListeningEvent({
    privateSession: true, listenedMs: 60_000, startedAt: "invalid",
    historyAfter: null, now,
  }), false);
  assert.equal(acceptsListeningEvent({
    privateSession: false, listenedMs: 1000, startedAt: boundary.toISOString(),
    historyAfter: boundary, now,
  }), true);
  assert.equal(acceptsListeningEvent({
    privateSession: false, listenedMs: 1000,
    startedAt: new Date(boundary.getTime() - 1).toISOString(),
    historyAfter: boundary, now,
  }), false);
  assert.equal(acceptsListeningEvent({
    privateSession: false, listenedMs: 1000, historyAfter: boundary, now,
  }), false);
});

test("history policy rejects future events only when they would otherwise be recorded", () => {
  assert.throws(() => acceptsListeningEvent({
    privateSession: false, listenedMs: 1000,
    startedAt: new Date(now.getTime() + 1).toISOString(), historyAfter: null, now,
  }), ListeningHistoryInputError);
});
