import type { MintApi } from "@mint/client";

export function greeting(hour: number) {
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

export async function loadHome(api: Pick<MintApi, "discover" | "catalog"> | null, signal: AbortSignal) {
  if (!api) throw new Error("Sign in to load your music.");
  const [personal, recent, rediscover, albums] = await Promise.all([
    api.discover("for-you", signal), api.discover("recent", signal), api.discover("rediscover", signal),
    api.catalog({ type: "album", size: 18, sort: "newest" }, signal),
  ]);
  return { personal, recent, rediscover, albums };
}
