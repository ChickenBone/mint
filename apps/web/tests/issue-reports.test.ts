import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { schema } from "@mint/core/db";
import { ISSUE_MESSAGE_MAX, ISSUE_REQUEST_MAX_BYTES } from "../src/lib/issue-report-model";
import {
  IssueReportError,
  createIssueReport,
  handleIssueReportPost,
  listIssueReports,
  parseIssueReport,
  sameOriginRequest,
  setIssueReportStatus,
} from "../src/lib/issue-reports";

const origin = "https://mint.example.test";
const noDb = () => { throw new Error("database must not be reached"); };
function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/issue-reports`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("report input is trimmed, sanitized and stripped of unknown fields", () => {
  const parsed = parseIssueReport({
    category: "lyrics",
    message: "  Line one\r\n\r\n\r\n\r\nLine\u0000 two\u202E  ",
    context: "  Quiet Orbit \n— The Paper Moons  ",
    userId: randomUUID(),
    status: "resolved",
    userAgent: "should not be stored",
  });
  assert.deepEqual(parsed, { category: "lyrics", message: "Line one\n\nLine two", context: "Quiet Orbit — The Paper Moons" });
  assert.equal(parseIssueReport({ category: "app", message: "Broken", context: "   " }).context, null);
  assert.equal(parseIssueReport({ category: "app", message: "Broken" }).context, null);
});

test("invalid reports are rejected with listener-friendly messages", () => {
  const rejects = (input: unknown, pattern: RegExp) => assert.throws(() => parseIssueReport(input),
    (error: unknown) => error instanceof IssueReportError && error.status === 400 && pattern.test(error.message));
  rejects({ category: "app", message: "  \u0000 " }, /what went wrong/);
  rejects({ category: "app", message: "x".repeat(ISSUE_MESSAGE_MAX + 1) }, /under 2,000 characters/);
  rejects({ category: "secret-admin", message: "hi" }, /Choose what/);
  rejects({ category: "app", message: "hi", context: "x".repeat(301) }, /Check the report/);
  rejects(null, /Check the report|Choose what/);
});

test("same-origin check rejects missing, foreign and cross-site requests", () => {
  assert.equal(sameOriginRequest(post({}), origin), true);
  assert.equal(sameOriginRequest(post({}, { origin: "https://evil.example" }), origin), false);
  assert.equal(sameOriginRequest(post({}, { "sec-fetch-site": "cross-site" }), origin), false);
  const noOrigin = new Request(`${origin}/api/issue-reports`, { method: "POST", body: "{}" });
  assert.equal(sameOriginRequest(noOrigin, origin), false);
});

test("the endpoint enforces CSRF, auth, content type and size before touching the database", async () => {
  const userId = randomUUID();
  const status = async (request: Request, id: string | null = userId) => {
    const response = await handleIssueReportPost(request, { userId: id, db: noDb, origin });
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    return response.status;
  };
  assert.equal(await status(post({}, { origin: "https://evil.example" })), 403);
  assert.equal(await status(post({}), null), 401);
  assert.equal(await status(post({}, { "content-type": "text/plain" })), 415);
  assert.equal(await status(post("x".repeat(ISSUE_REQUEST_MAX_BYTES + 1))), 413);
  assert.equal(await status(post("{not json")), 400);
  assert.equal(await status(post({ category: "app", message: "" })), 400);
});

const database = process.env.MUSIC_TEST_DATABASE_URL;
test("reports are stored per member, rate limited, listed for admins and resolvable", {
  skip: !database && "Set MUSIC_TEST_DATABASE_URL",
}, async () => {
  const namespace = `mint_reports_${randomUUID().replaceAll("-", "")}`, admin = new pg.Pool({ connectionString: database });
  await admin.query(`create database "${namespace}"`);
  const url = new URL(database!); url.pathname = `/${namespace}`;
  const pool = new pg.Pool({ connectionString: url.toString() }), db = drizzle(pool, { schema });
  try {
    const root = new URL("../../../packages/core/migrations/", import.meta.url);
    const journal = JSON.parse(await readFile(new URL("meta/_journal.json", root), "utf8")) as { entries: { tag: string }[] };
    for (const migration of journal.entries) await pool.query(await readFile(new URL(`${migration.tag}.sql`, root), "utf8"));
    const [member, other, operator] = await db.insert(schema.users).values(["member", "other", "operator"].map((name) =>
      ({ email: `${name}@reports.test`, name, status: "active" as const, role: name === "operator" ? "admin" as const : "user" as const, passwordHash: "fixture" }))).returning();

    const response = await handleIssueReportPost(post({ category: "lyrics", message: "<script>alert(1)</script> wrong verse",
      context: "Quiet Orbit — The Paper Moons", userId: other!.id }), { userId: member!.id, db: () => db, origin });
    assert.equal(response.status, 201);
    const created = await response.json() as { id: string };
    const [stored] = await db.select().from(schema.issueReports).where(eq(schema.issueReports.id, created.id));
    assert.equal(stored!.userId, member!.id, "The session user owns the report, never a client-supplied id");
    assert.equal(stored!.message, "<script>alert(1)</script> wrong verse");
    assert.equal(stored!.status, "open");

    const now = new Date();
    const burst = await Promise.allSettled(Array.from({ length: 8 }, () =>
      createIssueReport(db, member!.id, { category: "app", message: "Again" }, now)));
    assert.equal(burst.filter((result) => result.status === "fulfilled").length, 4, "Five reports per ten minutes, including the first");
    assert.ok(burst.every((result) => result.status === "fulfilled" || (result.reason instanceof IssueReportError && result.reason.status === 429)));
    await createIssueReport(db, other!.id, { category: "playback", message: "Skips" }, now);

    const later = new Date(now.getTime() + 11 * 60_000);
    await createIssueReport(db, member!.id, { category: "other", message: "Later" }, later);

    const listed = await listIssueReports(db);
    assert.equal(listed.openCount, 7);
    assert.equal(listed.open.length, 7);
    const lyric = listed.open.find((report) => report.id === created.id)!;
    assert.deepEqual(lyric.reporter, { name: "member", email: "member@reports.test" });
    assert.equal(lyric.context, "Quiet Orbit — The Paper Moons");

    assert.equal(await setIssueReportStatus(db, created.id, "resolved", operator!.id), true);
    assert.equal(await setIssueReportStatus(db, created.id, "resolved", operator!.id), false, "Resolving twice is a no-op");
    const afterResolve = await listIssueReports(db);
    assert.equal(afterResolve.openCount, 6);
    assert.equal(afterResolve.resolved[0]!.id, created.id);
    assert.equal(afterResolve.resolved[0]!.resolvedBy, "operator");
    assert.ok(afterResolve.resolved[0]!.resolvedAt);

    assert.equal(await setIssueReportStatus(db, created.id, "open", operator!.id), true);
    const [reopened] = await db.select().from(schema.issueReports).where(eq(schema.issueReports.id, created.id));
    assert.equal(reopened!.resolvedAt, null); assert.equal(reopened!.resolvedBy, null);
    await assert.rejects(setIssueReportStatus(db, "not-a-uuid", "resolved", operator!.id), IssueReportError);
    assert.equal(await setIssueReportStatus(db, randomUUID(), "resolved", operator!.id), false);

    await assert.rejects(pool.query("insert into issue_reports (user_id, category, message, status) values ($1, 'app', 'x', 'resolved')", [member!.id]),
      /check constraint/, "Resolved reports must carry a resolution time");
    await assert.rejects(pool.query("insert into issue_reports (user_id, category, message) values ($1, 'app', $2)", [member!.id, "x".repeat(2001)]),
      /check constraint/);

    await db.delete(schema.users).where(eq(schema.users.id, member!.id));
    assert.equal((await listIssueReports(db)).openCount, 1, "A deleted member's reports go with their account");
  } finally {
    await pool.end(); await admin.query(`drop database "${namespace}"`); await admin.end();
  }
});
