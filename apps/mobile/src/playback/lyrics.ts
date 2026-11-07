export interface LyricWord { time: number; text: string }
export interface LyricLine { time: number; text: string; words?: LyricWord[] }
export interface LyricsResult {
  lyrics: {
    source?: "LRCLIB" | "Lyrics.ovh";
    instrumental: boolean;
    plainLyrics: string | null;
    syncedLyrics: string | null;
  } | null;
  offsetMs?: number;
}

const milliseconds = (minutes: string, seconds: string, fraction = "") =>
  (Number(minutes) * 60 + Number(seconds)) * 1000 + Number(fraction.padEnd(3, "0"));

export function parseLyrics(source: string): LyricLine[] {
  const result: LyricLine[] = [];
  const offset = Number(/\[offset:([+-]?\d+)\]/i.exec(source)?.[1] ?? 0);
  for (const row of source.slice(0, 100_000).split(/\r?\n/)) {
    const content = row.replace(/\[\d{1,3}:\d{2}(?:\.\d{1,3})?\]/g, "").trim();
    const text = content.replace(/<\d{1,3}:\d{2}(?:\.\d{1,3})?>/g, "").trim();
    const words: LyricWord[] = [];
    for (const word of content.matchAll(/<(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?>([^<]*)/g)) {
      if (Number(word[2]) < 60 && word[4]) {
        words.push({ time: Math.max(0, milliseconds(word[1]!, word[2]!, word[3]) + offset), text: word[4] });
      }
    }
    for (const stamp of row.matchAll(/\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g)) {
      if (Number(stamp[2]) >= 60) continue;
      const time = Math.max(0, milliseconds(stamp[1]!, stamp[2]!, stamp[3]) + offset);
      const validWords = words.length > 0 && words.every((word, index) =>
        !/\S\s+\S/u.test(word.text) && word.time >= time &&
        (!index || word.time >= words[index - 1]!.time)) &&
        words.map((word) => word.text).join("").trim() === text;
      result.push({ time, text, ...(validWords ? { words } : {}) });
    }
  }
  return result.sort((a, b) => a.time - b.time);
}

export function activeLyric(lines: LyricLine[], milliseconds: number): number {
  let low = 0, high = lines.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (lines[mid]!.time <= milliseconds) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}
