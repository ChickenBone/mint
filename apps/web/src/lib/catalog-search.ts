import { and, or, sql, type SQL } from "drizzle-orm";
import { schema } from "@mint/core/db";
import { PLAYABLE } from "@mint/core/playback";

export function searchTerms(value: string) {
  return [...new Set(value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(Boolean))].slice(0, 12);
}
const t = schema.tracks;
export const searchDocument = sql`mint_search_text(${t.title} || ' ' || ${t.artist} || ' ' || coalesce(${t.album}, ''))`;
export function catalogSearch(value?: string): { where?: SQL; rank?: SQL } {
  const terms = searchTerms((value ?? "").slice(0, 100));
  if (!terms.length) return value?.trim() ? { where: sql`false` } : {};
  const query = terms.join(" "), prefix = terms.map((term) => `${term}:*`).join(" & ");
  const words = sql`to_tsvector('simple', ${searchDocument}) @@ to_tsquery('simple', ${prefix})`;
  const document = sql`candidate.document`;
  const tolerant = and(...terms.map((term) => or(sql`${document} like ${`%${term}%`}`, sql`public.word_similarity(${term}, ${document}) >= 0.38`)));
  return {
    where: sql`${t.id} in (
      select ${t.id} from ${t} where ${words}
      union select candidate.id from (
        select ${t.id} as id, ${searchDocument} as document from ${t} where ${PLAYABLE}
        order by ${searchDocument} operator(public.<->) ${query} limit 200
      ) candidate where ${tolerant}
    )`,
    rank: sql`(case when mint_search_text(${t.title}) = ${query} then 8 else 0 end)
      + (case when ${words} then 4 else 0 end)
      + public.word_similarity(${query}, ${searchDocument})`,
  };
}
