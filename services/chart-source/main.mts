import Redis from "ioredis";
import { createChartSourceServer } from "./service.mjs";
import type { ChartCacheStore } from "../../apps/web/src/lib/chart-cache";

if (!process.env.REDIS_URL) throw new Error("REDIS_URL is required for shared chart caching and rate limits.");
const port = Number(process.env.PORT ?? 3090);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535.");
const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 1, commandTimeout: 2500, connectTimeout: 2500, enableOfflineQueue: false,
});
redis.on("error", () => console.error("Chart source Redis connection unavailable."));
const store: ChartCacheStore = {
  get: (key) => redis.get(key),
  set: async (key, value, seconds, absent) => (absent
    ? await redis.set(key, value, "EX", seconds, "NX")
    : await redis.set(key, value, "EX", seconds)) === "OK",
  release: async (key, value) => {
    await redis.eval("if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end", 1, key, value);
  },
};
const server = createChartSourceServer({ store, enabled: process.env.MINT_CHARTS_ENABLED !== "false",
  ready: async () => { try { return await redis.ping() === "PONG"; } catch { return false; } } });
server.listen(port, "0.0.0.0", () => console.info(`Chart source listening on port ${port}.`));
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  server.close(() => { redis.disconnect(); });
  server.closeIdleConnections();
  setTimeout(() => { server.closeAllConnections(); redis.disconnect(); }, 10_000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
