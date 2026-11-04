import { schema } from "@mint/core/db";
import { sql } from "drizzle-orm";

const t = schema.tracks;
export const trackArtwork = sql<string>`case when coalesce(nullif(${t.plexRatingKey}, ''),
  nullif(${t.artworkUrl}, ''), nullif(${t.mbReleaseGroupId}, ''), nullif(${t.youtubeVideoId}, '')) is not null
  then '/api/artwork/' || ${t.id}::text end`;

export const albumArtwork = sql<string>`coalesce(
  min(case when nullif(${t.plexRatingKey}, '') is not null then ${trackArtwork} end),
  min(${trackArtwork}))`;
