import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getDb } from "./index";

export async function runMigrations(folder = process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), "migrations")) {
  await migrate(getDb(), { migrationsFolder: folder });
}
