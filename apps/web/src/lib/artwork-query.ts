import { schema } from "@mint/core/db";
import { sql } from "drizzle-orm";

const t = schema.tracks;
export const trackArtwork = sql<string>`coalesce(nullif(${t.artworkUrl}, ''), case
  when nullif(${t.youtubeVideoId}, '') is not null
  then 'https://i.ytimg.com/vi/' || ${t.youtubeVideoId} || '/mqdefault.jpg' end)`;
