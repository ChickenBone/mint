import { getDb } from "@mint/core/db";
import { getRedis } from "@mint/core/redis";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await Promise.all([getDb().execute(sql`select 1`), getRedis().ping()]);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
