import { PublicReadCache, type PublicCacheStore } from "./public-cache";

/** Injectable test storage; never used as an upstream fallback in production. */
export function publicCacheFixture(clock: () => number = () => Date.now()) {
  const entries = new Map<string, { value: string; until: number }>();
  const store: PublicCacheStore = {
    get: async (key) => {
      const entry = entries.get(key);
      if (!entry || entry.until <= clock()) { entries.delete(key); return null; }
      return entry.value;
    },
    set: async (key, value, seconds, absent) => {
      const previous = entries.get(key);
      if (absent && previous && previous.until > clock()) return false;
      entries.set(key, { value, until: clock() + seconds * 1000 });
      return true;
    },
    release: async (key, token) => { if (entries.get(key)?.value === token) entries.delete(key); },
    publish: async (key, value, seconds, lease, token) => {
      const owner = entries.get(lease);
      if (!owner || owner.until <= clock() || owner.value !== token) return false;
      entries.set(key, { value, until: clock() + seconds * 1000 });
      return true;
    },
  };
  return { store, entries, cache: new PublicReadCache(store, clock), instance: () => new PublicReadCache(store, clock) };
}
