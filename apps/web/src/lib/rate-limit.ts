import "server-only";
import { getRedis } from "@mint/core/redis";

/** Fixed-window limiter backed by Redis. Returns true when the action is allowed. */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<boolean> {
  const redis = getRedis();
  const k = `mint:rl:${key}`;
  const [[, count]] = (await redis.multi().incr(k).expire(k, windowSec, "NX").exec()) as [[null, number]];
  return count <= limit;
}
