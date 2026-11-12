/**
 * Captures public YouTube search listings for the audio-source regression corpus (developer tool, not run by Mint).
 *
 *   npx tsx apps/worker/src/audio-regression-capture.ts --limit 25 [--reported] [--refresh] [--pace 8]
 *
 * Songs come from Apple Music's US most-played chart (lengths from the iTunes lookup API) plus the reported failures
 * below. Only titles, channels, lengths and view counts are stored. Pacing is deliberately slow; stop on any refusal.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { audioSearchQueries, leadArtistName } from "@mint/core/matching";
import { parseYoutubeSearchPage } from "@mint/core/youtube-scrape";
import type { RegressionCorpus, RegressionEntry } from "./audio-regression";

const FIXTURE = fileURLToPath(new URL("./fixtures/audio-regression.json", import.meta.url));
const REPORTED: Array<{ artist: string; title: string }> = [
  { artist: "Tame Impala", title: "Expectation (demo)" },
  { artist: "Tame Impala", title: "Tell Me Where You Are" },
  { artist: "Cordae feat. Anderson .Paak", title: "RNP" },
  { artist: "Tame Impala with JENNIE", title: "Dracula" },
  { artist: "GENER8ION & Yung Lean", title: "STORM I" },
  { artist: "Megan Thee Stallion", title: "Sex Talk" },
  { artist: "Drake", title: "Passionfruit" },
];
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: number) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? Number(args[index + 1]) : fallback;
};
const limit = option("limit", 25), paceSec = option("pace", 8);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const slug = (value: string) => value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function json<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${new URL(url).host} returned HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function chartSongs() {
  const chart = await json<{ feed: { results: Array<{ id: string; name: string; artistName: string }> } }>(
    `https://rss.applemarketingtools.com/api/v2/us/music/most-played/${Math.min(100, Math.max(10, limit))}/songs.json`);
  const songs = chart.feed.results.slice(0, limit);
  const lookup = await json<{ results: Array<{ trackId: number; trackTimeMillis?: number }> }>(
    `https://itunes.apple.com/lookup?id=${songs.map((song) => song.id).join(",")}&entity=song`);
  const lengths = new Map(lookup.results.map((track) => [String(track.trackId), track.trackTimeMillis]));
  return songs.map((song) => ({ artist: song.artistName, title: song.name, source: "apple-most-played" as const,
    durationSec: lengths.get(song.id) ? Math.round(lengths.get(song.id)! / 100) / 10 : null }));
}

async function reportedSongs() {
  const songs = [];
  for (const song of REPORTED) {
    const found = await json<{ results: Array<{ trackName: string; artistName: string; trackTimeMillis?: number }> }>(
      `https://itunes.apple.com/search?entity=song&limit=10&term=${encodeURIComponent(`${leadArtistName(song.artist)} ${song.title}`)}`);
    const exact = found.results.find((track) => slug(track.trackName) === slug(song.title));
    songs.push({ ...song, source: "reported" as const, durationSec: exact?.trackTimeMillis ? Math.round(exact.trackTimeMillis / 100) / 10 : null });
    await sleep(1500);
  }
  return songs;
}

async function search(query: string) {
  const url = new URL("https://www.youtube.com/results");
  url.searchParams.set("search_query", query);
  url.searchParams.set("hl", "en");
  const response = await fetch(url, { redirect: "manual", headers: { "accept-language": "en-US,en;q=0.8",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" } });
  if (response.status !== 200) throw new Error(`YouTube returned HTTP ${response.status}; stopping capture.`);
  return parseYoutubeSearchPage(await response.text()).map(({ id, title, channel, durationSec, viewCount, rank }) =>
    ({ id, title, channel, durationSec, viewCount, rank }));
}

async function main() {
  const corpus: RegressionCorpus = await readFile(FIXTURE, "utf8").then(JSON.parse, () => ({ version: 1, capturedAt: "", entries: [] }));
  const songs = [...await chartSongs(), ...(flag("reported") ? await reportedSongs() : [])];
  let failures = 0;
  for (const song of songs) {
    const id = `${slug(leadArtistName(song.artist))}--${slug(song.title)}`;
    const existing = corpus.entries.find((entry) => entry.id === id);
    if (existing && !flag("refresh")) continue;
    const entry: RegressionEntry = { id, source: song.source, title: song.title, artist: song.artist,
      durationSec: song.durationSec, searches: {}, label: existing?.label };
    try {
      for (const { q } of audioSearchQueries(`${leadArtistName(song.artist)} ${song.title}`)) {
        entry.searches[q] = await search(q);
        await sleep(paceSec * 1000 + Math.random() * 2000);
      }
      failures = 0;
    } catch (error) {
      // Two failed songs in a row usually means YouTube is refusing us; stop rather than push harder.
      if (++failures >= 2 || /HTTP/.test(String(error))) throw error;
      console.warn(`skipped ${id}: ${error instanceof Error ? error.message : error}`);
      await sleep(paceSec * 2000);
      continue;
    }
    corpus.entries = [...corpus.entries.filter((other) => other.id !== id), entry];
    corpus.capturedAt = new Date().toISOString().slice(0, 10);
    await writeFile(FIXTURE, `${JSON.stringify(corpus, null, 1)}\n`);
    console.log(`captured ${id} (${Object.keys(entry.searches).length} searches)`);
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
