import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/db/schema.ts", "./src/db/analysis.ts", "./src/db/music.ts", "./src/db/devices.ts", "./src/db/listening.ts", "./src/db/playback-queues.ts", "./src/db/spotify.ts"],
  out: "./migrations",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://mint:mint@localhost:5432/mint" },
  strict: true,
});
