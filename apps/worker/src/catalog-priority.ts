import { configuredCatalogBridge, type CatalogBridge } from "@mint/core";
import { getDb } from "@mint/core/db";
import { getRedis } from "@mint/core/redis";
import { sql } from "drizzle-orm";
import { log } from "./log";

const verifiedLibraryIdentity = sql`m.musicbrainz_artist_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and exists (select 1 from tracks t where t.artist = m.artist_name
    and t.existing_library_key is not null
    and (t.mb_artist_id is null or lower(t.mb_artist_id) = m.musicbrainz_artist_id))
  and not exists (select 1 from tracks t where t.artist = m.artist_name
    and t.existing_library_key is not null and t.mb_artist_id is not null
    and lower(t.mb_artist_id) <> m.musicbrainz_artist_id)`;

type PriorityState = { addAfter: string; removeAfter: string };
type PriorityStore = {
  state(): Promise<PriorityState>;
  current(after: string): Promise<string[]>;
  acknowledged(after: string): Promise<string[]>;
  retained(ids: string[]): Promise<string[]>;
  save(add: string[], remove: string[], state: PriorityState): Promise<void>;
};

export async function syncCatalogPriority(bridge: Pick<CatalogBridge, "priority">, store: PriorityStore) {
  const state = await store.state();
  const [add, known] = await Promise.all([store.current(state.addAfter), store.acknowledged(state.removeAfter)]);
  const retained = new Set(known.length ? await store.retained(known) : []);
  const remove = known.filter((id) => !retained.has(id) && !add.includes(id));
  if (add.length || remove.length) await bridge.priority(add, remove);
  await store.save(add, remove, {
    addAfter: add.length === 50 ? add.at(-1)! : "",
    removeAfter: known.length === 50 ? known.at(-1)! : "",
  });
  return { added: add.length, removed: remove.length };
}

export async function scheduleCatalogPriority() {
  try {
    const bridge = configuredCatalogBridge();
    if (!bridge) return;
    const redis = getRedis(), key = bridge.stateKey;
    // This runs in the already deduplicated periodic artist-metadata maintenance job.
    const result = await syncCatalogPriority(bridge, {
      async state() {
        const [addAfter, removeAfter] = await redis.hmget(`${key}:cursor`, "add", "remove");
        return { addAfter: addAfter ?? "", removeAfter: removeAfter ?? "" };
      },
      async current(after) {
        const { rows } = await getDb().execute<{ id: string }>(sql`
          select distinct m.musicbrainz_artist_id as id from artist_metadata m
          where m.status = 'ready' and ${verifiedLibraryIdentity} and m.musicbrainz_artist_id > ${after}
          order by id limit 50`);
        return rows.map(({ id }) => id);
      },
      acknowledged: (after) => redis.zrangebylex(`${key}:ids`, after ? `(${after}` : "-", "+", "LIMIT", 0, 50),
      async retained(ids) {
        const { rows } = await getDb().execute<{ id: string }>(sql`
          select distinct m.musicbrainz_artist_id as id from artist_metadata m
          where m.status not in ('ambiguous', 'not_found') and ${verifiedLibraryIdentity}
            and m.musicbrainz_artist_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
        return rows.map(({ id }) => id);
      },
      async save(add, remove, state) {
        const tx = redis.multi();
        if (add.length) tx.zadd(`${key}:ids`, ...add.flatMap((id) => [0, id]));
        if (remove.length) tx.zrem(`${key}:ids`, ...remove);
        tx.hset(`${key}:cursor`, "add", state.addAfter, "remove", state.removeAfter);
        const replies = await tx.exec();
        if (!replies || replies.some(([error]) => error)) throw new Error("Catalog priority state could not be stored.");
      },
    });
    if (result.added || result.removed) log.info(result, "catalog artist priorities synchronized");
  } catch {
    // Never log the upstream URL/token, artist IDs, response body or fetch error.
    log.warn("catalog artist priorities unavailable; periodic maintenance will retry");
  }
}
