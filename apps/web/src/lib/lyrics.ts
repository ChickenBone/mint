import { z } from "zod";

export const lyricsSchema = z.object({
  id: z.number().int().positive(), instrumental: z.boolean(),
  plainLyrics: z.string().max(100_000).nullable(), syncedLyrics: z.string().max(100_000).nullable(),
});
export type Lyrics = z.infer<typeof lyricsSchema>;
export interface LyricLine { time: number; text: string }

export function parseLrc(source: string): LyricLine[] {
  const lines: LyricLine[] = [];
  const offset = Number(/\[offset:([+-]?\d+)\]/i.exec(source)?.[1] ?? 0);
  for (const line of source.split(/\r?\n/)) {
    const text = line.replace(/\[\d{1,3}:\d{2}(?:\.\d{1,3})?\]/g, "").trim();
    for (const match of line.matchAll(/\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g)) {
      if (Number(match[2]) >= 60) continue;
      lines.push({ time: Math.max(0, (Number(match[1]) * 60 + Number(match[2])) * 1000 + Number((match[3] ?? "").padEnd(3, "0")) + offset), text });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}
