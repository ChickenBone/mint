import { Redis, type RedisOptions } from "ioredis";

const globalForRedis = globalThis as unknown as { __mintRedis?: Redis };

export function createRedis(opts: RedisOptions = {}): Redis {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not set");
  return new Redis(url, { maxRetriesPerRequest: null, ...opts });
}

/** Shared command connection. Subscribers and BullMQ workers must use their own via createRedis(). */
export function getRedis(): Redis {
  globalForRedis.__mintRedis ??= createRedis();
  return globalForRedis.__mintRedis;
}
