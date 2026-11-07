import { getDb, schema } from "@mint/core/db";
import { PLAYABLE } from "@mint/core/playback";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { trackArtwork } from "./artwork-query";

const t = schema.tracks;
export const browseQuerySchema = z.object({
  facet: z.enum(["genre", "mood", "decade"]),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
  limit: z.coerce.number().int().min(1).max(48).default(24),
});
export type BrowseQuery = z.infer<typeof browseQuerySchema>;
type Row = { value: string; label: string; tracks: number; total: number; artwork: string | null };

function classificationQuery(field: "genres" | "moods", limit: number, offset: number): SQL {
  // Labels match the catalog's genre/mood filters exactly, so a category's count equals its playable songs.
  const labels = field === "genres"
    ? sql`(values (item->>'name'), (item->>'subgenre')) v(label)`
    : sql`(values (item->>'name')) v(label)`;
  const matches = (alias: SQL) => field === "genres"
    ? sql`(lower(coalesce(${alias}->>'name', '')) = page.value or lower(coalesce(${alias}->>'subgenre', '')) = page.value)`
    : sql`lower(coalesce(${alias}->>'name', '')) = page.value`;
  return sql`with labels as (
      select lower(v.label) as value, min(v.label) as label, count(distinct ${t.id})::int as tracks
      from ${t}
      join track_analysis ta on ta.track_id = ${t.id} and ta.result is not null
      cross join lateral jsonb_array_elements(coalesce(ta.result->'classification'->${sql.raw(`'${field}'`)}, '[]'::jsonb)) item
      cross join lateral ${labels}
      where ${PLAYABLE} and coalesce(v.label, '') <> ''
      group by lower(v.label)
    ), page as (select * from labels order by tracks desc, value limit ${limit} offset ${offset})
    select page.value, page.label, page.tracks, (select count(*)::int from labels) as total, art.artwork
    from page left join lateral (
      select ${trackArtwork} as artwork from track_analysis ta2
      join ${t} on ${t.id} = ta2.track_id
      cross join lateral jsonb_array_elements(coalesce(ta2.result->'classification'->${sql.raw(`'${field}'`)}, '[]'::jsonb)) item2
      where ta2.result is not null and ${PLAYABLE} and ${trackArtwork} is not null and ${matches(sql`item2`)}
      order by ${t.readyAt} desc nulls last limit 1
    ) art on true
    order by page.tracks desc, page.value`;
}

function decadeQuery(limit: number, offset: number): SQL {
  return sql`with labels as (
      select (floor(${t.year} / 10.0) * 10)::int as decade, count(*)::int as tracks
      from ${t} where ${PLAYABLE} and ${t.year} between 1000 and 2999 group by 1
    ), page as (select * from labels order by decade desc limit ${limit} offset ${offset})
    select page.decade::text as value, page.decade::text || 's' as label, page.tracks,
      (select count(*)::int from labels) as total, art.artwork
    from page left join lateral (
      select ${trackArtwork} as artwork from ${t}
      where ${PLAYABLE} and ${t.year} between page.decade and page.decade + 9 and ${trackArtwork} is not null
      order by ${t.readyAt} desc nulls last limit 1
    ) art on true
    order by page.decade desc`;
}

export async function browseCategories({ facet, offset, limit }: BrowseQuery) {
  const query = facet === "decade" ? decadeQuery(limit, offset) : classificationQuery(facet === "genre" ? "genres" : "moods", limit, offset);
  const { rows } = await getDb().execute<Row>(query);
  const total = rows[0]?.total ?? (offset ? await browseTotal(facet) : 0);
  return {
    facet, offset, total,
    nextOffset: offset + rows.length < total && rows.length ? offset + rows.length : null,
    items: rows.map((row) => ({ value: row.value, label: row.label, tracks: Number(row.tracks), artwork: row.artwork ?? null })),
  };
}

async function browseTotal(facet: BrowseQuery["facet"]) {
  const { rows } = await getDb().execute<Row>(facet === "decade" ? decadeQuery(1, 0) : classificationQuery(facet === "genre" ? "genres" : "moods", 1, 0));
  return Number(rows[0]?.total ?? 0);
}

export async function nativeBrowseResponse(request: Request) {
  const query = browseQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return Response.json({ error: "Invalid browse category request." }, { status: 400 });
  try { return Response.json(await browseCategories(query.data)); }
  catch (error) {
    console.error("Browse categories failed", error instanceof Error ? error.name : "Unknown failure");
    return Response.json({ error: "Browse categories could not load. Try again." }, { status: 503 });
  }
}
