import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

const globalForDb = globalThis as unknown as { __mintDb?: { db: Db; pool: pg.Pool } };

export function getDb(): Db {
  if (!globalForDb.__mintDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const pool = new pg.Pool({ connectionString: url, max: Number(process.env.DATABASE_POOL_MAX ?? 10) });
    pool.on("error", (err) => console.error("[db] idle client error", err));
    globalForDb.__mintDb = { db: drizzle(pool, { schema }), pool };
  }
  return globalForDb.__mintDb.db;
}

export async function closeDb() {
  await globalForDb.__mintDb?.pool.end();
  globalForDb.__mintDb = undefined;
}

export { schema };
