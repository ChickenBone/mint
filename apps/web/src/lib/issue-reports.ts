import { schema, type Db } from "@mint/core/db";
import { aliasedTable, and, asc, count, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  ISSUE_MESSAGE_MAX,
  ISSUE_REQUEST_MAX_BYTES,
  issueReportInput,
  type IssueReportView,
} from "./issue-report-model";

export const ISSUE_REPORT_LIMITS = [
  { windowMs: 10 * 60_000, max: 5 },
  { windowMs: 24 * 60 * 60_000, max: 20 },
] as const;

export class IssueReportError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const json = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { "cache-control": "private, no-store", vary: "Cookie" },
});

export function sameOriginRequest(request: Request, origin: string) {
  return request.headers.get("origin") === new URL(origin).origin && request.headers.get("sec-fetch-site") !== "cross-site";
}

export function parseIssueReport(raw: unknown) {
  const result = issueReportInput.safeParse(raw);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue?.path[0];
  if (field === "message") {
    throw new IssueReportError(400, issue?.code === "too_big"
      ? `Keep your report under ${ISSUE_MESSAGE_MAX.toLocaleString("en-US")} characters.`
      : "Tell us what went wrong.");
  }
  if (field === "category") throw new IssueReportError(400, "Choose what the problem is about.");
  throw new IssueReportError(400, "Check the report details and try again.");
}

export async function createIssueReport(db: Db, userId: string, raw: unknown, now = new Date()) {
  const input = parseIssueReport(raw);
  return db.transaction(async (tx) => {
    // Serialize per member so concurrent submissions cannot slip past the limits.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 784))`);
    for (const limit of ISSUE_REPORT_LIMITS) {
      const [row] = await tx
        .select({ total: count() })
        .from(schema.issueReports)
        .where(and(eq(schema.issueReports.userId, userId), gt(schema.issueReports.createdAt, new Date(now.getTime() - limit.windowMs))));
      if ((row?.total ?? 0) >= limit.max) {
        throw new IssueReportError(429, "You've sent several reports recently. Try again a little later.");
      }
    }
    const [report] = await tx
      .insert(schema.issueReports)
      .values({
        userId,
        category: input.category,
        message: input.message,
        context: input.context,
      })
      .returning({ id: schema.issueReports.id, createdAt: schema.issueReports.createdAt });
    return { id: report!.id, createdAt: report!.createdAt.toISOString() };
  });
}

export async function handleIssueReportPost(
  request: Request,
  context: { userId: string | null; db: () => Db; origin: string },
  authorizeOrigin: () => boolean = () => sameOriginRequest(request, context.origin),
) {
  try {
    if (!authorizeOrigin()) throw new IssueReportError(403, "Same-origin requests only.");
    if (!context.userId) throw new IssueReportError(401, "Sign in to report an issue.");
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new IssueReportError(415, "Send the report as JSON.");
    }
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > ISSUE_REQUEST_MAX_BYTES) throw new IssueReportError(413, "That report is too large.");
    const input = parseIssueReport(await readBoundedJson(request));
    return json(await createIssueReport(context.db(), context.userId, input), 201);
  } catch (error) {
    if (error instanceof IssueReportError) return json({ error: error.message }, error.status);
    console.error("[issue-reports] submission failed", error);
    return json({ error: "Your report couldn't be sent. Try again in a moment." }, 500);
  }
}

async function readBoundedJson(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new IssueReportError(400, "A report is required.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > ISSUE_REQUEST_MAX_BYTES) {
        await reader.cancel();
        throw new IssueReportError(413, "That report is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new IssueReportError(400, "Check the report details and try again.");
  }
}

const reporter = aliasedTable(schema.users, "reporter");
const resolver = aliasedTable(schema.users, "resolver");

export async function listIssueReports(db: Db, { openLimit = 200, resolvedLimit = 25 } = {}) {
  const columns = {
    id: schema.issueReports.id,
    category: schema.issueReports.category,
    message: schema.issueReports.message,
    context: schema.issueReports.context,
    status: schema.issueReports.status,
    createdAt: schema.issueReports.createdAt,
    resolvedAt: schema.issueReports.resolvedAt,
    reporterName: reporter.name,
    reporterEmail: reporter.email,
    resolverName: resolver.name,
  };
  const base = () => db
    .select(columns)
    .from(schema.issueReports)
    .leftJoin(reporter, eq(reporter.id, schema.issueReports.userId))
    .leftJoin(resolver, eq(resolver.id, schema.issueReports.resolvedBy));
  const [open, resolved, [openTotal]] = await Promise.all([
    base().where(eq(schema.issueReports.status, "open")).orderBy(desc(schema.issueReports.createdAt), asc(schema.issueReports.id)).limit(openLimit),
    base().where(eq(schema.issueReports.status, "resolved")).orderBy(desc(schema.issueReports.resolvedAt), asc(schema.issueReports.id)).limit(resolvedLimit),
    db.select({ total: count() }).from(schema.issueReports).where(eq(schema.issueReports.status, "open")),
  ]);
  const view = (row: (typeof open)[number]): IssueReportView => ({
    id: row.id,
    category: row.category,
    message: row.message,
    context: row.context,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    reporter: row.reporterName && row.reporterEmail ? { name: row.reporterName, email: row.reporterEmail } : null,
    resolvedBy: row.resolverName,
  });
  return { open: open.map(view), resolved: resolved.map(view), openCount: openTotal?.total ?? 0 };
}

const reportId = z.uuid();

export async function setIssueReportStatus(db: Db, id: string, status: "open" | "resolved", adminId: string) {
  if (!reportId.safeParse(id).success) throw new IssueReportError(400, "That report could not be found.");
  const [updated] = await db
    .update(schema.issueReports)
    .set(status === "resolved"
      ? { status, resolvedAt: new Date(), resolvedBy: adminId }
      : { status, resolvedAt: null, resolvedBy: null })
    .where(and(eq(schema.issueReports.id, id), sql`${schema.issueReports.status} <> ${status}`))
    .returning({ id: schema.issueReports.id });
  return Boolean(updated);
}
