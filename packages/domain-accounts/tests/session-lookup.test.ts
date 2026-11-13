import assert from "node:assert/strict";
import { test } from "node:test";
import {
  lookupBrowserSession,
  type SessionEvidence,
  type SessionLookupRepository,
} from "../src/session-lookup";

const token = "browser-session-token";
const tokenHash = "432b884e210a50239c230330ab316fa5da003c2334ab320ee5b61581a042cebd";
const instant = new Date("2030-01-02T03:04:05.000Z");
const now = () => new Date(instant);
const principal = {
  id: "12345678-1234-4234-8234-123456789012",
  email: " Not validated ",
  name: "  ",
  role: "user",
  status: "active",
} as const;

function evidence(overrides: Partial<SessionEvidence> = {}): SessionEvidence {
  return {
    expiresAt: new Date(instant.getTime() + 1),
    principal,
    ...overrides,
  };
}

test("missing and native tokens are denied without a repository lookup", async () => {
  const repository: SessionLookupRepository = {
    findByTokenHash: () => {
      throw new Error("repository must not be called");
    },
  };
  for (const input of [undefined, null, "", "mn1.", "mn1.native-token"]) {
    assert.equal(await lookupBrowserSession(input, repository, now), null);
  }
});

test("passes only the exact SHA256 token hash and returns the projected principal", async () => {
  const seen: string[] = [];
  const stored = {
    ...evidence(),
    token,
    tokenHash,
    principal: { ...principal, token, tokenHash, passwordHash: "private" },
  };
  const repository: SessionLookupRepository = {
    async findByTokenHash(hash) {
      seen.push(hash);
      return stored;
    },
  };
  const result = await lookupBrowserSession(token, repository, now);
  assert.deepEqual(seen, [tokenHash]);
  assert.notEqual(seen[0], token);
  assert.deepEqual(result, principal);
  assert.deepEqual(Object.keys(result ?? {}).sort(), ["email", "id", "name", "role", "status"]);
  assert.ok(!JSON.stringify(result).includes(token));
  assert.ok(!JSON.stringify(result).includes(tokenHash));
});

test("a missing or subsequently revoked session is denied on the next lookup", async () => {
  let stored: SessionEvidence | null = null;
  const repository: SessionLookupRepository = {
    async findByTokenHash() {
      return stored;
    },
  };
  assert.equal(await lookupBrowserSession(token, repository, now), null);
  stored = evidence();
  assert.deepEqual(await lookupBrowserSession(token, repository, now), principal);
  stored = null;
  assert.equal(await lookupBrowserSession(token, repository, now), null);
});

test("expiry must be strictly after the injected clock", async () => {
  for (const [offset, allowed] of [[-1, false], [0, false], [1, true]] as const) {
    const repository: SessionLookupRepository = {
      async findByTokenHash() {
        return evidence({ expiresAt: new Date(instant.getTime() + offset) });
      },
    };
    assert.deepEqual(await lookupBrowserSession(token, repository, now), allowed ? principal : null);
  }
});

test("checks expiry after the repository read rather than caching the lookup time", async () => {
  let time = instant.getTime();
  const repository: SessionLookupRepository = {
    async findByTokenHash() {
      time += 1;
      return evidence();
    },
  };
  assert.equal(await lookupBrowserSession(token, repository, () => new Date(time)), null);
});

test("does not exclude tokens that merely resemble the native prefix", async () => {
  const repository: SessionLookupRepository = {
    async findByTokenHash() {
      return evidence();
    },
  };
  assert.deepEqual(await lookupBrowserSession("mn1", repository, now), principal);
  assert.deepEqual(await lookupBrowserSession("MN1.native-token", repository, now), principal);
});

test("only active accounts are admitted, including both user and admin", async () => {
  for (const role of ["user", "admin"] as const) {
    for (const status of ["pending", "active", "denied", "disabled"] as const) {
      const account = { ...principal, role, status };
      const repository: SessionLookupRepository = {
        async findByTokenHash() {
          return evidence({ principal: account });
        },
      };
      assert.deepEqual(await lookupBrowserSession(token, repository, now), status === "active" ? account : null);
    }
  }
});

test("repository failures propagate rather than becoming anonymous results", async () => {
  const failure = new Error("repository unavailable");
  const repository: SessionLookupRepository = {
    async findByTokenHash() {
      throw failure;
    },
  };
  await assert.rejects(lookupBrowserSession(token, repository, now), (error) => error === failure);
});
