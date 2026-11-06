import { z } from "zod";

export const lyricsSchema = z.object({
  id: z.number().int().positive().optional(), instrumental: z.boolean(),
  source: z.enum(["LRCLIB", "Lyrics.ovh"]).default("LRCLIB"),
  plainLyrics: z.string().max(100_000).nullable(), syncedLyrics: z.string().max(100_000).nullable(),
});
export type Lyrics = z.infer<typeof lyricsSchema>;
export interface LyricWord { time: number; text: string }
export interface LyricLine { time: number; text: string; words?: LyricWord[] }

const milliseconds = (minutes: string, seconds: string, fraction = "") =>
  (Number(minutes) * 60 + Number(seconds)) * 1000 + Number(fraction.padEnd(3, "0"));

export function parseLrc(source: string): LyricLine[] {
  const lines: LyricLine[] = [];
  const offset = Number(/\[offset:([+-]?\d+)\]/i.exec(source)?.[1] ?? 0);
  for (const line of source.split(/\r?\n/)) {
    const content = line.replace(/\[\d{1,3}:\d{2}(?:\.\d{1,3})?\]/g, "").trim();
    const text = content.replace(/<\d{1,3}:\d{2}(?:\.\d{1,3})?>/g, "").trim();
    const words: LyricWord[] = [];
    for (const match of content.matchAll(/<(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?>([^<]*)/g)) {
      if (Number(match[2]) >= 60 || !match[4]) continue;
      words.push({ time: Math.max(0, milliseconds(match[1]!, match[2]!, match[3]) + offset), text: match[4] });
    }
    for (const match of line.matchAll(/\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g)) {
      if (Number(match[2]) >= 60) continue;
      const time = Math.max(0, milliseconds(match[1]!, match[2]!, match[3]) + offset);
      const validWords = words.length > 0 && words.every((word, i) => !/\S\s+\S/u.test(word.text) && word.time >= time && (!i || word.time >= words[i - 1]!.time)) &&
        words.map((word) => word.text).join("").trim() === text;
      lines.push({ time, text, ...(validWords ? { words } : {}) });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

export function lyricTiming(lyrics: Lyrics): "Word by word" | "Line by line" | "Plain text" | "Instrumental" {
  if (lyrics.instrumental) return "Instrumental";
  const lines = parseLrc(lyrics.syncedLyrics ?? "");
  const sung = lines.filter((line) => line.text);
  if (sung.length && sung.every((line) => line.words?.length)) return "Word by word";
  return sung.length ? "Line by line" : "Plain text";
}

export function rankLyrics(candidates: Lyrics[]): Lyrics[] {
  const score = (lyrics: Lyrics) => ({ "Word by word": 3, "Line by line": 2, "Plain text": 1, Instrumental: 4 })[lyricTiming(lyrics)];
  return candidates.filter((lyrics) => lyrics.instrumental || parseLrc(lyrics.syncedLyrics ?? "").some((line) => line.text) || lyrics.plainLyrics?.trim())
    .sort((a, b) => score(b) - score(a));
}
