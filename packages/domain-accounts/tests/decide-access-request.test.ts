import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { AccountPrincipal } from "@mint/contracts";
import {
  AccessRequestDecisionForbiddenError,
  createAccessRequestDecider,
  type AccessRequestDecisionRepository,
  type PendingAccessDecision,
} from "../src/index";

const admin: AccountPrincipal = {
  id: randomUUID(),
  email: "admin@example.test",
  name: "Admin",
  role: "admin",
  status: "active",
};
const input = { userId: randomUUID(), approve: true };

function harness(overrides: {
  decidePendingAccess?: (value: { userId: string; decision: PendingAccessDecision }) => Promise<void>;
  countPending?: () => Promise<number>;
  notify?: (value: { pending: number }) => Promise<void>;
  now?: () => Date;
} = {}) {
  const calls: unknown[] = [];
  const repository: AccessRequestDecisionRepository = {
    async decidePendingAccess(value) {
      calls.push(["decide", value]);
      await overrides.decidePendingAccess?.(value);
    },
    async countPending() {
      calls.push(["count"]);
      return overrides.countPending ? overrides.countPending() : 3;
    },
  };
  const decide = createAccessRequestDecider({
    repository,
    async notify(value) {
      calls.push(["notify", value]);
      await overrides.notify?.(value);
    },
    now: overrides.now ?? (() => new Date("2031-02-03T04:05:06.000Z")),
  });
  return { calls, decide };
}

test("approves as an active admin, clones the clock value, then counts and notifies", async () => {
  const clockValue = new Date("2032-03-04T05:06:07.000Z");
  let clockCalls = 0;
  const { calls, decide } = harness({ now: () => { clockCalls++; return clockValue; } });

  assert.equal(await decide(input, admin), undefined);
  assert.equal(clockCalls, 1);
  assert.deepEqual(calls, [
    ["decide", {
      userId: input.userId,
      decision: { status: "active", approvedAt: new Date(clockValue), approvedBy: admin.id },
    }],
    ["count"],
    ["notify", { pending: 3 }],
  ]);
  const decision = (calls[0] as [string, { decision: PendingAccessDecision }])[1].decision;
  assert.ok(decision.status === "active");
  assert.notEqual(decision.approvedAt, clockValue);
});

test("denies without reading the clock or adding approval fields", async () => {
  const { calls, decide } = harness({
    now() { assert.fail("denial must not read the clock"); },
  });

  await decide({ ...input, approve: false }, admin);
  assert.deepEqual(calls, [
    ["decide", { userId: input.userId, decision: { status: "denied" } }],
    ["count"],
    ["notify", { pending: 3 }],
  ]);
});

test("rejects absent, malformed, inactive and non-admin actors before effects", async () => {
  const invalidActors: unknown[] = [
    null,
    { ...admin, role: "user" },
    { ...admin, id: "not-an-id" },
    ...(["pending", "denied", "disabled"] as const).map((status) => ({ ...admin, status })),
  ];
  for (const actor of invalidActors) {
    const { calls, decide } = harness();
    await assert.rejects(
      decide(input, actor as AccountPrincipal | null),
      (error: unknown) => {
        assert.ok(error instanceof AccessRequestDecisionForbiddenError);
        assert.equal(error.message, "Forbidden");
        return true;
      },
    );
    assert.deepEqual(calls, []);
  }
});

test("validates the target UUID and boolean decision before effects", async () => {
  for (const badInput of [
    { userId: "not-a-uuid", approve: true },
    { userId: input.userId, approve: "true" },
  ]) {
    const { calls, decide } = harness();
    await assert.rejects(decide(badInput as never, admin), /Invalid access-request decision/);
    assert.deepEqual(calls, []);
  }
});

test("rejects invalid approval dates before repository or notification effects", async () => {
  const { calls, decide } = harness({ now: () => new Date(Number.NaN) });
  await assert.rejects(decide(input, admin), /Invalid approval time/);
  assert.deepEqual(calls, []);
});

test("notifies after a no-op pending update without disclosing target existence", async () => {
  const { calls, decide } = harness({
    async decidePendingAccess() {},
    async countPending() { return 0; },
  });

  assert.equal(await decide(input, admin), undefined);
  assert.deepEqual(calls, [
    ["decide", { userId: input.userId, decision: {
      status: "active",
      approvedAt: new Date("2031-02-03T04:05:06.000Z"),
      approvedBy: admin.id,
    } }],
    ["count"],
    ["notify", { pending: 0 }],
  ]);
});

test("propagates repository, count and notification failures without masking them", async () => {
  const repositoryError = new Error("repository failure");
  const repositoryFailure = harness({
    async decidePendingAccess() { throw repositoryError; },
  });
  await assert.rejects(repositoryFailure.decide(input, admin), (error) => error === repositoryError);
  assert.deepEqual(repositoryFailure.calls.map((call) => (call as unknown[])[0]), ["decide"]);

  const countError = new Error("count failure");
  const countFailure = harness({ async countPending() { throw countError; } });
  await assert.rejects(countFailure.decide(input, admin), (error) => error === countError);
  assert.deepEqual(countFailure.calls.map((call) => (call as unknown[])[0]), ["decide", "count"]);

  const notifyError = new Error("notification failure");
  const notifyFailure = harness({ async notify() { throw notifyError; } });
  await assert.rejects(notifyFailure.decide(input, admin), (error) => error === notifyError);
  assert.deepEqual(notifyFailure.calls.map((call) => (call as unknown[])[0]), ["decide", "count", "notify"]);
});

test("waits for pending notification completion", async () => {
  let markStarted = () => {};
  const notificationStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let release = () => {};
  const notificationGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let complete = false;
  const { decide } = harness({
    async notify() {
      markStarted();
      await notificationGate;
      complete = true;
    },
  });

  const result = decide(input, admin);
  await notificationStarted;
  assert.equal(complete, false);
  release();
  await result;
  assert.equal(complete, true);
});
