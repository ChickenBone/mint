import { createHash, randomUUID } from "node:crypto";
import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { createRedis } from "./redis";

// Node's 250 ms per-address connect window drops slow NAT/WSL routes to public providers (ETIMEDOUT).
if (getDefaultAutoSelectFamilyAttemptTimeout() < 2_500) setDefaultAutoSelectFamilyAttemptTimeout(2_500);

/** Server-only storage: values must be validated public metadata, never account responses. */
export interface PublicCacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, seconds: number, absent?: boolean): Promise<boolean>;
  release(key: string, token: string): Promise<void>;
  publish(key: string, value: string, seconds: number, lease: string, token: string): Promise<boolean>;
}
export class PublicProviderBusyError extends Error {
  constructor(public readonly provider: string, public readonly retryAfter: number) {
    super("Public metadata provider is temporarily unavailable");
  }
}
export class PublicCacheUnavailableError extends Error {
  constructor() { super("Public metadata cache is unavailable; upstream requests are paused"); }
}
export function publicRetryAfter(value: string | null, now = Date.now(), fallback = 60): number {
  const seconds = value === null ? fallback : /^\d+$/.test(value.trim()) ? Number(value) : (Date.parse(value) - now) / 1000;
  return Number.isFinite(seconds) ? Math.max(1, Math.min(86400, Math.ceil(seconds))) : fallback;
}
export function publicCacheKey(provider: string, version: string, parameters: unknown): string {
  return `mint:public:${provider}:${version}:${createHash("sha256").update(JSON.stringify(parameters)).digest("hex")}`;
}
export function canonicalPublicUrl(value: string | URL): string {
  const url = new URL(value);
  if (url.username || url.password || url.hash) throw new Error("Public cache URLs must not contain credentials or fragments");
  url.searchParams.sort();
  return url.href;
}
interface Entry<T> { value: T; fetchedAt: number; freshUntil: number; keepUntil: number }
export interface PublicReadResult<T> {
  value: T; fetchedAt: number; ageSeconds: number; stale: boolean; retryAfter: number | null;
}
export interface PublicReadOptions<T> {
  provider: string; key: string;
  freshSeconds: number; keepSeconds: number; negativeSeconds?: number;
  maxBytes: number; validate: (value: unknown) => T;
  negative?: (value: T) => boolean;
  spacingSeconds?: number;
  timeoutMs?: number;
  respectCooldownForFresh?: boolean;
  signal?: AbortSignal;
  load: (signal: AbortSignal) => Promise<T>;
}

export class PublicReadCache {
  private readonly pending = new Map<string, Promise<PublicReadResult<unknown>>>();
  private readonly hot = new Map<string, string>();
  private hotBytes = 0;
  private unavailableUntil = 0;
  constructor(private readonly store: PublicCacheStore, private readonly now = Date.now) {}
  private async command<T>(run: () => Promise<T>): Promise<T> {
    if (this.unavailableUntil > this.now()) throw new PublicCacheUnavailableError();
    try { return await run(); }
    catch (error) {
      this.unavailableUntil = this.now() + 30_000;
      console.error("Public metadata cache command failed; upstream reads are paused", {
        category: error instanceof Error ? error.name : "UnknownStoreError",
      });
      throw new PublicCacheUnavailableError();
    }
  }
  private remember(key: string, raw: string) {
    const previous = this.hot.get(key);
    if (previous) { this.hotBytes -= Buffer.byteLength(previous); this.hot.delete(key); }
    const size = Buffer.byteLength(raw);
    while (this.hot.size && (this.hot.size >= 128 || this.hotBytes + size > 16 * 1024 ** 2)) {
      const oldest = this.hot.keys().next().value!;
      this.hotBytes -= Buffer.byteLength(this.hot.get(oldest)!); this.hot.delete(oldest);
    }
    if (size <= 16 * 1024 ** 2) { this.hot.set(key, raw); this.hotBytes += size; }
  }
  private parse<T>(raw: string | null, options: PublicReadOptions<T>): Entry<T> | null {
    if (!raw || Buffer.byteLength(raw) > options.maxBytes + 1024) return null;
    try {
      const entry = JSON.parse(raw) as Entry<unknown>;
      if (![entry.fetchedAt, entry.freshUntil, entry.keepUntil].every(Number.isFinite) ||
        entry.fetchedAt > this.now() + 300_000 || entry.keepUntil <= this.now() ||
        entry.freshUntil < entry.fetchedAt || entry.keepUntil < entry.freshUntil ||
        entry.keepUntil - entry.fetchedAt > Math.max(options.keepSeconds, options.freshSeconds) * 1000) return null;
      return { ...entry, value: options.validate(entry.value) };
    } catch {
      console.error("Invalid public metadata cache entry; validated refresh required", { provider: options.provider });
      return null;
    }
  }
  private result<T>(entry: Entry<T>, retryAfter: number | null = null): PublicReadResult<T> {
    return { value: structuredClone(entry.value), fetchedAt: entry.fetchedAt,
      ageSeconds: Math.max(0, Math.floor((this.now() - entry.fetchedAt) / 1000)),
      stale: entry.freshUntil <= this.now(), retryAfter };
  }
  async read<T>(options: PublicReadOptions<T>): Promise<PublicReadResult<T>> {
    options.signal?.throwIfAborted();
    let task = this.pending.get(options.key);
    if (!task) {
      if (this.pending.size >= 64) throw new PublicProviderBusyError(options.provider, 5);
      task = this.readStored(options).finally(() => this.pending.delete(options.key));
      this.pending.set(options.key, task);
    }
    if (!options.signal) return structuredClone(await task) as PublicReadResult<T>;
    const signal = options.signal;
    return new Promise((resolve, reject) => {
      const cancel = () => reject(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
      task!.then((result) => resolve(structuredClone(result) as PublicReadResult<T>), reject)
        .finally(() => signal.removeEventListener("abort", cancel));
      if (signal.aborted) cancel();
    });
  }
  private async readStored<T>(options: PublicReadOptions<T>): Promise<PublicReadResult<T>> {
    let cached = this.parse(this.hot.get(options.key) ?? null, options);
    const cool = `mint:public:cooldown:${options.provider}`;
    const lock = `${options.key}:lease`, token = randomUUID();
    let leased = false;
    const requireNoCooldown = async () => {
      if (!options.respectCooldownForFresh) return;
      const delay = Number(await this.command(() => this.store.get(cool)));
      if (delay > this.now()) throw new PublicProviderBusyError(options.provider, Math.ceil((delay - this.now()) / 1000));
    };
    const fallback = (error: unknown) => {
      if (cached && !options.negative?.(cached.value) && cached.keepUntil > this.now() && !options.respectCooldownForFresh) {
        console.error("Public metadata refresh unavailable; serving a retained cache value", {
          provider: options.provider, ageSeconds: Math.max(0, Math.floor((this.now() - cached.fetchedAt) / 1000)),
          category: error instanceof Error ? error.name : "UnknownRefreshError",
        });
        return { ...this.result(cached, error instanceof PublicProviderBusyError ? error.retryAfter : 30), stale: true };
      }
      throw error;
    };
    try {
      const raw = await this.command(() => this.store.get(options.key));
      cached = this.parse(raw, options) ?? cached;
      if (cached && raw) this.remember(options.key, raw);
      const delay = options.respectCooldownForFresh || !cached || cached.freshUntil <= this.now()
        ? Number(await this.command(() => this.store.get(cool))) : 0;
      if (options.respectCooldownForFresh && delay > this.now()) {
        throw new PublicProviderBusyError(options.provider, Math.ceil((delay - this.now()) / 1000));
      }
      if (cached && cached.freshUntil > this.now()) return this.result(cached);
      if (delay > this.now()) return fallback(new PublicProviderBusyError(options.provider, Math.ceil((delay - this.now()) / 1000)));
      leased = await this.command(() => this.store.set(lock, token, 2 * Math.ceil((options.timeoutMs ?? 15000) / 1000) + 5, true));
      if (!leased) {
        if (cached && !options.negative?.(cached.value)) {
          await requireNoCooldown();
          return { ...this.result(cached, 3), stale: true };
        }
        const deadline = Date.now() + (options.timeoutMs ?? 15000);
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          const entry = this.parse(await this.command(() => this.store.get(options.key)), options);
          await requireNoCooldown();
          if (entry) return this.result(entry);
          if (!await this.command(() => this.store.get(lock))) break;
        }
        throw new PublicProviderBusyError(options.provider, 3);
      }
      // A previous lease holder may have published between our initial read and acquisition.
      const latest = this.parse(await this.command(() => this.store.get(options.key)), options);
      if (latest && latest.freshUntil > this.now()) {
        await requireNoCooldown();
        return this.result(latest);
      }
      const spacing = options.spacingSeconds ?? 1;
      const throttle = `mint:public:throttle:${options.provider}`, throttleDeadline = Date.now() + (options.timeoutMs ?? 15000);
      while (!await this.command(() => this.store.set(throttle, token, spacing, true))) {
        const cooldown = Number(await this.command(() => this.store.get(cool)));
        if (cooldown > this.now()) throw new PublicProviderBusyError(options.provider, Math.ceil((cooldown - this.now()) / 1000));
        if (Date.now() >= throttleDeadline) throw new PublicProviderBusyError(options.provider, spacing);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const cooldown = Number(await this.command(() => this.store.get(cool)));
      if (cooldown > this.now()) throw new PublicProviderBusyError(options.provider, Math.ceil((cooldown - this.now()) / 1000));
      const signal = AbortSignal.timeout(options.timeoutMs ?? 15000);
      const value = options.validate(await options.load(signal));
      signal.throwIfAborted();
      await requireNoCooldown();
      const fresh = options.negative?.(value) ? options.negativeSeconds ?? 300 : options.freshSeconds;
      const keep = options.negative?.(value) ? fresh : Math.max(fresh, options.keepSeconds);
      const fetchedAt = this.now();
      const entry = { value, fetchedAt, freshUntil: fetchedAt + fresh * 1000, keepUntil: fetchedAt + keep * 1000 };
      const serialized = JSON.stringify(entry);
      if (Buffer.byteLength(serialized) > options.maxBytes + 1024) throw new Error("Public cache value exceeds its byte budget");
      if (!await this.command(() => this.store.publish(options.key, serialized, keep, lock, token)))
        throw new PublicProviderBusyError(options.provider, 3);
      this.remember(options.key, serialized);
      return this.result(entry);
    } catch (error) {
      if (leased && !(error instanceof PublicCacheUnavailableError)) {
        const seconds = error instanceof PublicProviderBusyError ? error.retryAfter : 30;
        try { await this.command(() => this.store.set(cool, String(this.now() + seconds * 1000), seconds)); }
        catch { /* Cache outages pause subsequent upstream work through command(). */ }
      }
      return fallback(error);
    } finally {
      if (leased) {
        try { await this.command(() => this.store.release(lock, token)); }
        catch { /* A bounded lease expires if Redis cannot release it. */ }
      }
    }
  }
}

let shared: PublicReadCache | undefined;
export function redisPublicCacheStore(connection: () => Pick<ReturnType<typeof createRedis>, "get" | "set" | "eval">): PublicCacheStore {
  return {
    get: (key) => connection().get(key),
    set: async (key, value, seconds, absent) => (absent
      ? await connection().set(key, value, "EX", seconds, "NX") : await connection().set(key, value, "EX", seconds)) === "OK",
    release: async (key, token) => { await connection().eval(
      "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end", 1, key, token); },
    publish: async (key, value, seconds, lease, token) => Number(await connection().eval(
      "if redis.call('get',KEYS[2]) == ARGV[1] then redis.call('set',KEYS[1],ARGV[2],'EX',ARGV[3]); return 1 else return 0 end",
      2, key, lease, token, value, seconds)) === 1,
  };
}
export function getPublicReadCache(): PublicReadCache {
  if (!shared) {
    let redis: ReturnType<typeof createRedis> | undefined;
    const connection = () => {
      if (!redis) {
        redis = createRedis({ maxRetriesPerRequest: 1, commandTimeout: 2000, connectTimeout: 2000 });
        redis.on("error", () => console.error("Public metadata cache connection unavailable"));
      }
      return redis;
    };
    shared = new PublicReadCache(redisPublicCacheStore(connection));
  }
  return shared;
}
