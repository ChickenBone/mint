import { sql } from "drizzle-orm";
import { WORKER_ONLINE_MS } from "./agent-protocol";
import type { Db } from "./db";
import type { Stats } from "./events";

export async function computeStats(db: Db): Promise<Stats> {
  const { rows } = await db.execute<{
    tracks: string;
    artists: string;
    albums: string;
    duration: string | null;
    bytes: string | null;
    sonic: string;
    lidarr: string;
    cobalt: string;
    existing: string;
    ready_today: string;
    failed: string;
  }>(sql`
    with lib as (select * from tracks where stage in ('ready', 'analyzing'))
    select
      (select count(*) from lib) as tracks,
      (select count(distinct lower(artist)) from lib) as artists,
      (select count(distinct lower(artist) || '|' || lower(album)) from lib where album is not null) as albums,
      (select sum(duration_sec) from lib) as duration,
      (select sum(bytes) from lib) as bytes,
      (select count(*) from lib where sonic_analyzed) as sonic,
      (select count(*) from lib where source = 'lidarr') as lidarr,
      (select count(*) from lib where source = 'cobalt') as cobalt,
      (select count(*) from lib where existing_library_key is not null and source is null) as existing,
      (select count(*) from lib where ready_at > now() - interval '24 hours') as ready_today,
      (select count(*) from tracks where stage = 'failed') as failed
  `);
  const stageRows = await db.execute<{ stage: string; n: string }>(
    sql`select stage, count(*) as n from tracks where stage not in ('ready','failed') group by stage`,
  );
  const members = await db.execute<{ n: string }>(sql`select count(*) as n from users where status = 'active'`);
  const workers = await db.execute<{ n: string }>(
    sql`select count(*) as n from workers where status = 'active' and last_seen_at > now() - make_interval(secs => ${WORKER_ONLINE_MS / 1000})`,
  );
  const r = rows[0]!;
  return {
    tracks: Number(r.tracks),
    artists: Number(r.artists),
    albums: Number(r.albums),
    members: Number(members.rows[0]?.n ?? 0),
    durationSec: Number(r.duration ?? 0),
    bytes: Number(r.bytes ?? 0),
    sonicAnalyzed: Number(r.sonic),
    bySource: { lidarr: Number(r.lidarr), cobalt: Number(r.cobalt) },
    existingTracks: Number(r.existing),
    byStage: Object.fromEntries(stageRows.rows.map((s) => [s.stage, Number(s.n)])),
    readyToday: Number(r.ready_today),
    failed: Number(r.failed),
    workersOnline: Number(workers.rows[0]?.n ?? 0),
    updatedAt: new Date().toISOString(),
  };
}
