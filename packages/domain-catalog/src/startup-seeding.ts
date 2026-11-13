export const CATALOG_STARTUP_SEED_LIMITS = Object.freeze({
  maxJobs: 128,
  maxCountries: 50,
  maxYoutubeChannels: 64,
});

const sources = {
  apple: { task: "chart", host: "rss.marketingtools.apple.com", kind: "song", priority: 100 },
  listenbrainz: { task: "lb-chart", host: "api.listenbrainz.org", kind: "song", priority: 100 },
  ytmusic: { task: "ytm-chart", host: "music.youtube.com", kind: "artist", priority: 100 },
  youtube: { task: "yt-feed", host: "www.youtube.com", kind: "artist", priority: 20 },
  deezer: { task: "deezer-chart", host: "api.deezer.com", kind: "song", priority: 100 },
  audius: { task: "audius-chart", host: "discoveryprovider.audius.co", kind: "song", priority: 100 },
  archive: { task: "archive-chart", host: "archive.org", kind: "album", priority: 100 },
  openverse: { task: "openverse-chart", host: "api.openverse.org", kind: "song", priority: 100 },
  openwhyd: { task: "openwhyd-chart", host: "openwhyd.org", kind: "song", priority: 100 },
} as const;

export type CatalogSeedSource = keyof typeof sources;

export interface CatalogStartupSeedConfig {
  /** Enabling a source is explicit permission to schedule it, not to bypass its policies. */
  readonly enabledSources: readonly CatalogSeedSource[];
  readonly countries: readonly string[];
  readonly youtubeChannels: readonly string[];
  readonly maxJobs: number;
}

export interface CatalogSeedJob {
  readonly key: string;
  readonly source: CatalogSeedSource;
  readonly task: (typeof sources)[CatalogSeedSource]["task"];
  readonly host: string;
  readonly kind: "artist" | "album" | "song";
  readonly country: string;
  readonly identifier: string;
  readonly priority: number;
  readonly reason: "startup";
}

export interface CatalogSeedStore {
  /**
   * Atomically insert by key, retaining the key across restarts and completed jobs.
   * Existing leases, attempts, due times, backoff and operator pauses must not change.
   * A queue that expires completed keys needs a separate durable receipt.
   */
  insertIfAbsent(job: CatalogSeedJob, signal?: AbortSignal): Promise<"inserted" | "existing">;
}

export interface CatalogSeedScheduleResult {
  readonly planned: number;
  readonly inserted: number;
  readonly existing: number;
}

/** Pure startup intent, mirroring standalone Store.seed; no fetches or graph expansion. */
export function planCatalogStartupSeeds(
  config: CatalogStartupSeedConfig,
): readonly CatalogSeedJob[] {
  if (!Number.isSafeInteger(config.maxJobs)
    || config.maxJobs < 1 || config.maxJobs > CATALOG_STARTUP_SEED_LIMITS.maxJobs) {
    throw new RangeError("Catalog startup maxJobs must be an integer from 1 to 128");
  }
  if (config.enabledSources.length > Object.keys(sources).length) {
    throw new RangeError("Too many Catalog startup sources");
  }
  if (config.countries.length > CATALOG_STARTUP_SEED_LIMITS.maxCountries) {
    throw new RangeError("Catalog startup supports at most 50 countries");
  }
  if (config.youtubeChannels.length > CATALOG_STARTUP_SEED_LIMITS.maxYoutubeChannels) {
    throw new RangeError("Catalog startup supports at most 64 YouTube channels");
  }
  for (const source of config.enabledSources) {
    if (!Object.hasOwn(sources, source)) {
      throw new TypeError("Unsupported Catalog startup source");
    }
  }
  for (const country of config.countries) {
    if (typeof country !== "string" || !/^[a-z]{2}$/i.test(country)) {
      throw new TypeError("Catalog startup countries must be two-letter storefronts");
    }
  }
  for (const channel of config.youtubeChannels) {
    if (typeof channel !== "string" || !/^UC[A-Za-z0-9_-]{22}$/.test(channel)) {
      throw new TypeError("Catalog startup requires explicit YouTube channel IDs");
    }
  }

  const enabled = new Set(config.enabledSources);
  const countries = [...new Set(config.countries.map((country) => country.toLowerCase()))].sort();
  const channels = [...new Set(config.youtubeChannels)].sort();
  if ((enabled.has("apple") || enabled.has("ytmusic")) && countries.length === 0) {
    throw new RangeError("Enabled storefront chart sources require at least one country");
  }

  const jobs: CatalogSeedJob[] = [];
  function add(source: CatalogSeedSource, country: string, identifier = ""): void {
    const definition = sources[source];
    jobs.push(Object.freeze({
      ...definition,
      source,
      country,
      identifier,
      key: `catalog:startup:${definition.task}:${identifier || country}`,
      reason: "startup",
    }));
  }
  // Fixed source order and sorted scopes make retries independent of config ordering.
  for (const source of Object.keys(sources) as CatalogSeedSource[]) {
    if (!enabled.has(source)) continue;
    if (source === "apple" || source === "ytmusic") {
      for (const country of countries) add(source, country);
    } else if (source === "youtube") {
      for (const channel of channels) add(source, "global", channel);
    } else {
      add(source, "global");
    }
  }
  if (jobs.length > config.maxJobs) {
    throw new RangeError("Catalog startup seed plan exceeds maxJobs; reduce configured scopes");
  }
  return Object.freeze(jobs);
}

/**
 * Schedules only; counts are not fetched/ingested metadata or completed worker jobs.
 * Storage failures propagate. Retrying after partial insertion is safe only when
 * the supplied store meets its atomic, durable insert-if-absent contract.
 */
export async function scheduleCatalogStartupSeeds(
  config: CatalogStartupSeedConfig,
  store: CatalogSeedStore,
  signal?: AbortSignal,
): Promise<CatalogSeedScheduleResult> {
  const jobs = planCatalogStartupSeeds(config);
  signal?.throwIfAborted();
  let inserted = 0;
  let existing = 0;
  for (const job of jobs) {
    signal?.throwIfAborted();
    const outcome = await store.insertIfAbsent(job, signal);
    if (outcome === "inserted") inserted += 1;
    else if (outcome === "existing") existing += 1;
    else throw new TypeError("Invalid Catalog seed store outcome");
  }
  signal?.throwIfAborted();
  return Object.freeze({ planned: jobs.length, inserted, existing });
}
