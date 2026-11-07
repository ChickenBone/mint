import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { Redis } from "ioredis";
import { Queue } from "bullmq";
import { and, eq } from "drizzle-orm";
import { getDb, closeDb, schema } from "@mint/core/db";
import { musicCollections, musicEntries, musicLikes } from "@mint/core/music-db";
import { sha256, verifyToken } from "@mint/core/crypto";
import { CHARTS } from "../../src/lib/charts.ts";

assert.equal(process.env.MINT_REDESIGN_FIXTURE, "true", "This tool must only run against its isolated fictional instance.");
assert.match(new URL(process.env.DATABASE_URL).pathname, /^\/mint_(demo|redesign_demo)$/);
assert.match(process.env.REDIS_URL, /^redis:\/\/127\.0\.0\.1:\d+\/?$/);
const base = "http://127.0.0.1:3087", db = getDb(), redis = new Redis(process.env.REDIS_URL);
const screenshotDir = process.env.MINT_PREVIEW_SCREENSHOTS
  ? resolve(process.env.MINT_PREVIEW_SCREENSHOTS)
  : fileURLToPath(new URL("../../../../docs/screenshots/", import.meta.url));
const catalog = [
  ["Quiet Orbit", "The Paper Moons", "Rooms in Blue", "#243f59", "#a9cdb7"],
  ["Soft Current", "Sunday Static", "Soft Current", "#4f3040", "#ec9a82"],
  ["Almost Home", "Amber Lines", "Almost Home", "#5d4b28", "#dbd8af"],
  ["A Little Further", "North Lantern", "Passing Weather", "#41565b", "#d4b5a1"],
  ["Glass Garden", "Fern Arcade", "Glass Garden", "#244946", "#d8d69c"],
  ["Night Letters", "The Paper Moons", "Night Letters", "#262a52", "#afa0cb"],
  ["A Place to Begin", "Velvet Coast", "A Place to Begin", "#633a31", "#d9b791"],
  ["Slow Light", "Sunday Static", "Slow Light", "#394e45", "#d8e6c0"],
  ["The Long Way", "Juniper Club", "The Long Way", "#393550", "#cb93b7"],
  ["Morning Tide", "Amber Lines", "Morning Tide", "#2c4655", "#e7c89a"],
  ["Out of Season", "Fern Arcade", "Out of Season", "#4a4b31", "#cfc29e"],
  ["West of Here", "North Lantern", "West of Here", "#634f48", "#bdccd4"],
];
const missingId = "b00b6c22-98cd-4ce0-84bb-d8dd07146b45";
const missing = { id: "demo-missing", title: "Late Windows", artist: "Sunday Static", album: "Night Rooms", durationSec: 180, recordingId: missingId };
const searchRecording = { id: "a13416ce-f0b7-484e-a460-7b6cb748bf1a", title: "Imaginary Signal", artist: "The Paper Moons", album: "Fictional Nights" };
if (process.env.MINT_PREVIEW_RESET === "true") {
  const existing = await db.select().from(schema.tracks);
  assert.ok(existing.every((track) => !track.filePath || track.filePath.startsWith("/fictional-")), "Only this tool's fictional database can be reset.");
  await db.execute("truncate table tracks, users cascade");
}
const originals = await db.select({ id: schema.tracks.id }).from(schema.tracks);
if (originals.length) throw new Error("Use a fresh, empty fictional database; existing tracks will not be deleted.");
await db.delete(schema.users).where(eq(schema.users.email, "alex@fictional.test"));
const [user] = await db.insert(schema.users).values({ name: "Alex", email: "alex@fictional.test", role: "admin", status: "active", passwordHash: "fictional-not-a-login" }).returning();
const [inactive] = await db.insert(schema.users).values({ name: "Pending Listener", email: `${randomUUID()}@fictional.test`, status: "pending", passwordHash: "fictional-not-a-login" }).returning();
const token = randomUUID(), pendingToken = randomUUID();
await db.insert(schema.sessions).values([user, inactive].map((person, i) => ({ id: sha256(i ? pendingToken : token), userId: person.id, expiresAt: new Date(Date.now() + 3600000) })));
const tracks = await db.insert(schema.tracks).values(catalog.flatMap(([title, artist, album], i) =>
  Array.from({ length: 3 }, (_, n) => ({ title: n ? `${title}, Part ${n + 1}` : title, artist, album, durationSec: 180 + n * 12,
    stage: "ready", codec: "flac", bytes: 19000000 + i * 120000, filePath: `/fictional-read-only/${i}-${n}.flac`,
    existingFilePath: `/fictional-read-only/${i}-${n}.flac`, existingCodec: "flac", plexRatingKey: String(i * 3 + n + 1),
    libraryMatchKey: `${artist.toLowerCase()}|${title.toLowerCase()}`, readyAt: new Date(Date.now() - i * 3600000),
    year: 2026, progress: 1 })))).returning();
await db.insert(schema.userTracks).values(tracks.slice(0, 15).map((track) => ({ userId: user.id, trackId: track.id, origin: "youtube" })));
await db.insert(musicLikes).values(tracks.slice(3, 11).map((track) => ({ userId: user.id, trackId: track.id })));
const [demoPlaylist] = await db.insert(musicCollections).values({ ownerId: user.id, title: "Evening drives" }).returning();
await db.insert(musicEntries).values(tracks.slice(0, 4).map((track, position) => ({ collectionId: demoPlaylist.id, trackId: track.id, position })));
await db.insert(schema.playlists).values({ userId: user.id, youtubePlaylistId: "fictional-playlist", title: "After hours", itemCount: 12, syncEnabled: false });
await db.insert(schema.tracks).values([
  { title: "The Last Tram", artist: "Juniper Club", album: "City Notes", stage: "downloading", progress: .64, detail: "Fictional demo · downloading source", attempts: 1 },
  { title: "Paper Planes", artist: "Velvet Coast", album: "Folded Skies", stage: "failed", error: "Fictional demo · source unavailable. Choose a different source or retry.", attempts: 2 },
]);
await db.insert(schema.workers).values({ userId: user.id, name: "Living room server", tokenHash: sha256(randomUUID()), tokenHint: "fictional", status: "active", version: "3.5.0", completed: 126, lastSeenAt: new Date(), capabilities: { download: true } });
await db.insert(schema.youtubeAccounts).values({ userId: user.id, googleSub: "fictional", email: "alex@fictional.test", channelTitle: "Alex’s collection",
  accessTokenEnc: "fictional-not-a-token", refreshTokenEnc: "fictional-not-a-token", expiresAt: new Date(Date.now() + 3600000), scope: "", lastSyncedAt: new Date(), autoSync: false });
const entries = tracks.filter((_, i) => i % 3 === 0).slice(0, 5).map((track, i) => ({
  id: `demo-${i}`, rank: i + 1, title: track.title, artist: track.artist, album: track.album, durationSec: track.durationSec,
  recordingId: null, isrc: null, artwork: null, genres: [], url: "https://example.com/fictional-music",
}));
entries.splice(1, 0, { ...missing, rank: 2, isrc: null, artwork: null, genres: [], url: "https://example.com/fictional-music" });
entries.forEach((entry, i) => { entry.rank = i + 1; });
for (const chart of CHARTS) await redis.set(`mint:charts:v1:${chart.id}`, JSON.stringify({
  entries, period: "Fictional demonstration · not a real provider ranking", providerUpdatedAt: new Date().toISOString(),
  fetchedAt: new Date().toISOString(), revision: "fictional-preview", notice: "Demo content only. All songs, artists and rankings shown here are fictional.",
}), "EX", 3600);

const coverCatalog = [...catalog, [missing.title, missing.artist, missing.album, "#304951", "#d9b0a1"]];
const covers = await Promise.all(coverCatalog.map(async ([title, artist, , dark, light], i) => sharp(Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${dark}"/><stop offset="1" stop-color="#161b21"/></linearGradient><filter id="blur"><feGaussianBlur stdDeviation="10"/></filter></defs><rect width="640" height="640" fill="url(#g)"/><circle cx="${240 + i * 11}" cy="${250 + i * 8}" r="${125 + i * 3}" fill="none" stroke="${light}" stroke-width="2" opacity=".8"/><circle cx="360" cy="300" r="95" fill="${light}" opacity=".28" filter="url(#blur)"/><path d="M-50 470 Q 200 ${250 + i * 12} 700 370L700 700H-50Z" fill="${light}" opacity=".2"/><text x="52" y="77" fill="${light}" font-family="sans-serif" font-size="16" letter-spacing="3">${artist.toUpperCase()}</text><text x="52" y="550" fill="#faf7ed" font-family="sans-serif" font-size="34" font-weight="600">${title}</text><text x="54" y="582" fill="${light}" font-family="sans-serif" font-size="12" letter-spacing="4">FICTIONAL SESSIONS · ${String(i + 1).padStart(2, "0")}</text></svg>`
)).png().toBuffer()));
const samples = 8000 * 200, wav = Buffer.alloc(44 + samples * 2);
wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / 8000) * 25), 44 + i * 2);
const gateway = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1:3088"), id = url.pathname.split("/").at(-1);
    if (url.pathname === "/test/recordings") {
      res.setHeader("content-type", "application/json");
      if (url.searchParams.get("query")?.includes(searchRecording.title)) {
        return res.end(JSON.stringify({ recordings: [{ ...searchRecording, length: 180000,
          "artist-credit": [{ name: searchRecording.artist }], releases: [{ title: searchRecording.album }] }] }));
      }
      return res.end(JSON.stringify({ recordings: [{ id: missingId, title: missing.title, length: 180000, "artist-credit": [{ name: missing.artist }], releases: [{ title: missing.album }] }] }));
    }
    if (url.pathname.startsWith("/artwork/")) {
      assert.equal(verifyToken("artwork", req.headers.authorization?.slice(7))?.trackId, id);
      const index = tracks.findIndex((track) => track.id === id);
      res.setHeader("content-type", "image/png"); res.setHeader("cache-control", "public, max-age=3600");
      return res.end(covers[index < 0 ? covers.length - 1 : Math.floor(index / 3)]);
    }
    if (url.pathname.startsWith("/playback/")) {
      const claim = verifyToken("playback", req.headers.authorization?.slice(7));
      const [person] = claim ? await db.select().from(schema.users).where(eq(schema.users.id, claim.userId)) : [];
      assert.equal(person?.status, "active"); assert.equal(claim?.trackId, id);
      const [track] = await db.select().from(schema.tracks).where(eq(schema.tracks.id, id));
      assert.ok(track?.filePath && ["ready", "analyzing"].includes(track.stage));
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/), start = Number(range?.[1] ?? 0), end = Math.min(Number(range?.[2] || wav.length - 1), wav.length - 1);
      res.statusCode = range ? 206 : 200; res.setHeader("content-type", "audio/wav"); res.setHeader("accept-ranges", "bytes");
      res.setHeader("content-length", end - start + 1); if (range) res.setHeader("content-range", `bytes ${start}-${end}/${wav.length}`);
      return res.end(req.method === "HEAD" ? undefined : wav.subarray(start, end + 1));
    }
    res.statusCode = 404; res.end("Fictional preview gateway: endpoint not simulated");
  } catch (error) { res.statusCode = 403; res.end(String(error)); }
});
await new Promise((resolve) => gateway.listen(3088, "127.0.0.1", resolve));
console.log("Fictional library, chart cache and signed media gateway ready.");
if (process.env.MINT_PREVIEW_SEED_ONLY === "true") {
  console.log("Set MINT_PREVIEW_SEED_ONLY=false to execute browser checks.");
} else {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  const failures = [];
  const historyAborts = [];
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.on("pageerror", (error) => failures.push(`${page.url()}: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") failures.push(`${page.url()}: ${message.text()}`); });
  page.on("requestfailed", (request) => {
    if (request.url().endsWith("/api/music/history") && request.failure()?.errorText === "net::ERR_ABORTED") historyAborts.push(request.url());
  });
  await context.addCookies([{ name: "mint_session", value: token, url: base }]);
  const shot = async (name, route) => {
    if (route) await page.goto(`${base}${route}`);
    await page.getByRole("status", { name: "Loading page" }).waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Loading music…" }).waitFor({ state: "hidden" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => Array.from(document.images).every((image) => {
      const bounds = image.getBoundingClientRect();
      const visible = bounds.width > 0 && bounds.height > 0 &&
        bounds.right > 0 && bounds.left < innerWidth && bounds.bottom > 0 && bounds.top < innerHeight;
      return !visible || (image.complete && image.naturalWidth > 0);
    }));
    assert.ok(!await page.getByText("Application error:").count(), route);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `No horizontal page overflow: ${route}`);
    await page.screenshot({ path: `${screenshotDir}/${name}.png` });
  };
  await mkdir(screenshotDir, { recursive: true });
  try {
    const publicContext = await browser.newContext();
    assert.equal((await publicContext.request.get(`${base}/api/player/audio/${tracks[0].id}`)).status(), 401);
    assert.equal((await publicContext.request.post(`${base}/api/charts/request`, { data: { chart: "apple-us", entry: missing.id }, headers: { origin: base } })).status(), 401);
    const publicRows = await (await publicContext.request.get(`${base}/api/charts?chart=apple-us`)).json();
    assert.ok(publicRows.items.every((row) => row.item === null));
    await publicContext.addCookies([{ name: "mint_session", value: pendingToken, url: base }]);
    assert.equal((await publicContext.request.get(`${base}/api/player/audio/${tracks[0].id}`)).status(), 401);
    await publicContext.close();
    await page.goto(`${base}/app/discover`);
    await page.waitForURL((url) => url.pathname === "/app/search");
    await page.getByRole("heading", { name: "Explore", exact: true }).waitFor();
    const sidebarPlaylists = page.getByRole("list", { name: "Mint playlists" });
    await sidebarPlaylists.getByRole("link", { name: "Evening drives", exact: true }).waitFor();
    try { await page.waitForFunction(() => document.querySelector('[data-player-mounted="ready"]'), { timeout: 10000 }); }
    catch (error) {
      console.error("Player startup diagnostics", failures,
        await page.locator("[data-player-mounted]").getAttribute("data-player-mounted"),
        await page.locator('[role="alert"]').allTextContents());
      throw error;
    }
    await page.getByRole("button", { name: "Play Daily blend", exact: true }).click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll("audio")).some((audio) => !audio.paused && audio.currentTime > .1));
    await shot("discover");
    await page.getByRole("link", { name: "Open Daily blend", exact: true }).click();
    await page.getByRole("heading", { name: "Daily blend", exact: true }).waitFor();
    await shot("discover-mix");
    await page.getByRole("navigation", { name: "Mix navigation" }).getByRole("link", { name: "Search", exact: true }).click();
    await page.getByRole("link", { name: "Open United States Top 50", exact: true }).click();
    await page.getByRole("button", { name: `Play ${tracks[0].title}`, exact: true }).click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll("audio")).some((audio) => !audio.paused && audio.currentTime > .1));
    const playing = await page.evaluate(() => { const audio = Array.from(document.querySelectorAll("audio")).find((element) => !element.paused); audio.dataset.previewIdentity = "persistent"; return audio.currentTime; });
    await page.getByRole("link", { name: "Home", exact: true }).first().click(); await page.waitForURL("**/app");
    await page.waitForFunction((previous) => document.querySelector("audio[data-preview-identity]")?.currentTime > previous, playing);
    await shot("home"); await page.getByRole("link", { name: "Search", exact: true }).first().click(); await page.waitForURL("**/app/search");
    await page.getByRole("heading", { name: "Explore", exact: true }).waitFor();
    await page.getByRole("link", { name: "Open United States Top 50", exact: true }).click();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "1 not in your library yet" }).waitFor();
    assert.equal(await db.$count(schema.tracks, eq(schema.tracks.mbRecordingId, missingId)), 0, "Chart playback must not acquire missing songs");
    assert.equal((await context.request.post(`${base}/api/charts/request`, { data: { chart: "apple-us", entry: missing.id }, headers: { origin: "https://unrelated.test" } })).status(), 403);
    await shot("charts");
    await page.getByRole("button", { name: `Add to library: ${missing.title} by ${missing.artist}`, exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Request sent" }).waitFor();
    await shot("chart-requested");
    let requested;
    let queuedJobs = [];
    const queue = new Queue("mint-acquire", { connection: { host: "127.0.0.1", port: Number(new URL(process.env.REDIS_URL).port) } });
    for (let attempt = 0; attempt < 40 && !queuedJobs.length; attempt++) {
      [requested] = await db.select().from(schema.tracks).where(eq(schema.tracks.mbRecordingId, missingId));
      const jobs = await queue.getJobs(["waiting", "delayed", "active", "completed"]);
      queuedJobs = requested ? jobs.filter((job) => job.data.trackId === requested.id) : [];
      if (!queuedJobs.length) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(requested);
    assert.equal(queuedJobs.length, 1, "The existing BullMQ pipeline receives exactly one job");
    await queue.close();
    const again = await context.request.post(`${base}/api/charts/request`, { data: { chart: "apple-us", entry: missing.id }, headers: { origin: base } });
    assert.ok(again.ok() || again.status() === 429, `Duplicate request: ${again.status()} ${await again.text()}`);
    assert.equal(await db.$count(schema.tracks, eq(schema.tracks.mbRecordingId, missingId)), 1);
    // Simulate worker completion only; never download or acquire third-party audio for screenshots.
    await db.update(schema.tracks).set({ stage: "downloading", progress: .64 }).where(eq(schema.tracks.id, requested.id));
    await page.getByText("Adding · 64%", { exact: true }).waitFor({ timeout: 20000 });
    await shot("chart-processing");
    await db.update(schema.tracks).set({ stage: "ready", progress: 1, filePath: "/fictional-downloaded/late-windows.flac", plexRatingKey: "fictional" }).where(eq(schema.tracks.id, requested.id));
    await page.getByRole("button", { name: `Play ${missing.title}`, exact: true }).waitFor({ timeout: 20000 });
    await shot("chart-playable");
    assert.equal(await page.locator("audio[data-preview-identity]").count(), 1, "Chart progress refresh must not replace the player");
    await page.getByRole("button", { name: "Refresh chart", exact: true }).click();
    await page.getByRole("button", { name: `Play ${missing.title}`, exact: true }).waitFor();
    const chartBody = await (await context.request.get(`${base}/api/charts?chart=apple-us`)).json();
    for (const [status, message] of [["stale", "Fictional provider timeout; cached ranking retained."], ["empty", null], ["error", "Fictional cache unavailable."]]) {
      await page.route("**/api/charts?*", (route) => route.fulfill({ json: { ...chartBody, status, notice: message,
        ...(status === "stale" ? {} : { items: [], total: 0, nextOffset: null }) } }));
      await page.getByRole("button", { name: "Refresh chart", exact: true }).click();
      await page.getByText(status === "stale" ? "This chart may be out of date." : status === "empty" ? "Nothing on this chart yet." : "This chart isn’t available right now.", { exact: status !== "stale" }).waitFor();
      await page.unroute("**/api/charts?*");
    }
    await page.getByRole("button", { name: "Refresh chart", exact: true }).click();
    await page.getByRole("button", { name: `Play ${missing.title}`, exact: true }).waitFor();
    await page.getByRole("button", { name: `Play ${missing.title}`, exact: true }).click();
    await page.getByRole("link", { name: "Search", exact: true }).first().click();
    const searchbox = page.getByRole("searchbox", { name: "Search songs, artists or albums" });
    await searchbox.fill(searchRecording.title);
    assert.equal(await searchbox.inputValue(), searchRecording.title, "Search input state reflects typed text");
    assert.equal(new URL(page.url()).searchParams.get("q"), searchRecording.title, "Typed search is reflected in the URL");
    await page.getByText(searchRecording.title, { exact: true }).waitFor();
    assert.equal(await db.$count(schema.tracks, eq(schema.tracks.mbRecordingId, searchRecording.id)), 0, "Searching must not request a song");
    await shot("search-missing");
    await page.getByRole("button", { name: "Add to library", exact: true }).click();
    await page.getByText("Adding to your library…", { exact: true }).waitFor();
    await shot("search-requested");
    assert.equal(await db.$count(schema.tracks, eq(schema.tracks.mbRecordingId, searchRecording.id)), 1, "The selected fictional recording is requested once");
    await page.getByRole("link", { name: "Home", exact: true }).first().click();
    await page.waitForURL((url) => url.pathname === "/app");
    await page.getByRole("link", { name: "Browse all music", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/app/library");
    await page.waitForFunction(() => document.querySelector("audio[data-preview-identity]")?.paused === false);
    await shot("library");

    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    await page.keyboard.press("/");
    await page.waitForURL((url) => url.pathname === "/app/search");
    await searchbox.fill("Quiet Orbit");
    assert.equal(await searchbox.inputValue(), "Quiet Orbit", "Search remains editable after navigation");
    const searchPlayButton = page.getByRole("button", { name: "Play Quiet Orbit", exact: true });
    await searchPlayButton.waitFor();
    await searchPlayButton.click();
    try {
      await page.waitForFunction(() => Array.from(document.querySelectorAll("audio")).some((audio) => !audio.paused && audio.currentTime > .1));
    } catch (error) {
      console.error("Search playback diagnostics", await page.locator("audio").evaluateAll((audio) => audio.map((element) => ({ paused: element.paused, time: element.currentTime, src: element.currentSrc }))),
        await page.locator('[role="alert"]').allTextContents());
      throw error;
    }
    await page.evaluate(() => {
      document.querySelectorAll("audio").forEach((audio) => { delete audio.dataset.previewIdentity; });
      const active = Array.from(document.querySelectorAll("audio")).find((audio) => !audio.paused);
      if (active) active.dataset.previewIdentity = "persistent";
    });

    const rowTitle = "Quiet Orbit";
    const rowMenuButton = page.getByRole("region", { name: "Songs", exact: true })
      .getByRole("button", { name: `More options for ${rowTitle}`, exact: true });
    await rowMenuButton.click();
    await page.waitForTimeout(100);
    await page.getByRole("menu", { name: `Actions for ${rowTitle}` }).waitFor();
    const firstMenuItem = await page.evaluate(() => document.activeElement?.textContent);
    await page.keyboard.press("ArrowDown");
    assert.notEqual(await page.evaluate(() => document.activeElement?.textContent), firstMenuItem, "ArrowDown advances the track menu focus");
    await page.keyboard.press("Home");
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), firstMenuItem, "Home returns to the first track menu action");
    await page.keyboard.press("Escape");
    await page.waitForFunction((label) => document.activeElement?.getAttribute("aria-label") === label, `More options for ${rowTitle}`);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), `More options for ${rowTitle}`, "Closing the row menu restores focus");

    await rowMenuButton.click();
    await page.getByRole("menuitem", { name: /Save to playlist/ }).click();
    await page.getByRole("menu").locator("div.max-h-52").evaluate((list) => { list.scrollTop = list.scrollHeight; });
    const newPlaylist = page.getByRole("menuitem", { name: "Create playlist…" });
    await newPlaylist.evaluate((item) => item.scrollIntoView({ block: "end" }));
    await newPlaylist.click();
    await page.getByRole("textbox", { name: "New playlist name" }).fill("UX actions");
    await page.getByRole("button", { name: "Create and add song" }).click();
    await page.getByRole("status").filter({ hasText: "Added to UX actions." }).waitFor();
    await sidebarPlaylists.getByRole("link", { name: "UX actions", exact: true }).waitFor({ timeout: 10000 });
    const [createdCollection] = await db.select().from(musicCollections).where(and(eq(musicCollections.ownerId, user.id), eq(musicCollections.title, "UX actions")));
    assert.ok(createdCollection);
    assert.equal(await db.$count(musicEntries, eq(musicEntries.collectionId, createdCollection.id)), 1, "The selected track is added to the new playlist");
    await page.getByRole("button", { name: "Undo" }).click();
    await page.getByRole("status").filter({ hasText: "Added to UX actions." }).waitFor({ state: "hidden" });
    assert.equal(await db.$count(musicEntries, eq(musicEntries.collectionId, createdCollection.id)), 0, "Undo removes the exact new playlist entry");

    await rowMenuButton.click();
    await page.getByRole("menuitem", { name: "Download song" }).click();
    await page.waitForURL((url) => url.pathname === "/app/collection" && url.searchParams.get("tab") === "downloads");
    await shot("downloads");
    await page.getByRole("link", { name: "Open now playing" }).click();
    await page.waitForURL("**/app/now-playing");
    const queueTab = page.getByRole("tab", { name: "Queue" });
    await queueTab.focus(); await page.keyboard.press("End");
    await page.getByRole("tab", { name: "Lyrics" }).waitFor();
    assert.equal(await page.getByRole("tab", { name: "Lyrics" }).getAttribute("aria-selected"), "true");
    await page.getByRole("button", { name: "Report an issue", exact: true }).click();
    const report = page.getByRole("dialog", { name: "Report an issue" });
    await report.getByRole("radio", { name: "Lyrics are wrong or missing" }).waitFor();
    assert.equal(await report.getByRole("radio", { name: "Lyrics are wrong or missing" }).isChecked(), true);
    await report.getByLabel("Tell us what happened").fill("Fictional lyrics issue");
    await report.getByRole("button", { name: "Send report" }).click();
    await report.getByText("Thanks. Your report was sent to the people who run this server.").waitFor();
    assert.equal(await db.$count(schema.issueReports, eq(schema.issueReports.message, "Fictional lyrics issue")), 1);
    await report.getByRole("button", { name: "Done" }).click();
    await queueTab.click();
    await page.getByRole("region", { name: "Current song" }).getByRole("button", { name: "More options for Quiet Orbit", exact: true }).click();
    await page.getByRole("menuitem", { name: "Like", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    const playerBeforeDevices = await page.evaluate(() => document.querySelector("audio[data-preview-identity]")?.currentTime ?? 0);
    await page.getByRole("link", { name: "Devices", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/app/settings" && url.searchParams.get("section") === "devices");
    await page.waitForFunction((previous) => document.querySelector("audio[data-preview-identity]")?.currentTime > previous, playerBeforeDevices);
    await page.goBack();
    await page.waitForURL("**/app/now-playing");
    await shot("now-playing");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("link", { name: "Close now playing" }).click();
    await page.getByRole("link", { name: "Search", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/app/search");
    const mobileSearchbox = page.getByRole("searchbox", { name: "Search songs, artists or albums" });
    await mobileSearchbox.waitFor();
    assert.equal(await mobileSearchbox.evaluate((element) => element === document.activeElement), true);
    await page.goto(`${base}/app/search?q=${encodeURIComponent(searchRecording.title)}`);
    await page.getByText(searchRecording.title, { exact: true }).waitFor();
    await shot("mobile-search");
    await page.getByRole("link", { name: "Home", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/app");
    await page.goto(`${base}/app/music?view=search&q=Quiet%20Orbit`);
    await page.waitForURL((url) => url.pathname === "/app/search" && url.searchParams.get("q") === "Quiet Orbit");
    await shot("search");
    await page.goto(`${base}/app/library?tab=songs`);
    await page.waitForURL((url) => url.pathname === "/app/library" && url.searchParams.get("type") === "track");
    await page.goto(`${base}/app/discover?chart=apple-us`);
    await page.waitForURL("**/app/discover/charts/apple-us");
    await shot("mobile-home", "/app");
    await shot("mobile-library", "/app/library");
    await shot("mobile-now-playing", "/app/now-playing");
    await page.setViewportSize({ width: 360, height: 800 }); await shot("narrow-library", "/app/library");
    await page.setViewportSize({ width: 768, height: 1024 });     await shot("tablet-discover", "/app/search");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await shot("liked", "/app/collection?tab=likes");
    await page.getByText("8 songs", { exact: true }).waitFor();
    await page.getByText("Previously imported favorites", { exact: true }).click();
    await page.getByRole("button", { name: "Add Quiet Orbit to Liked songs" }).click();
    await page.getByText("9 songs", { exact: true }).waitFor();
    await page.getByRole("link", { name: "Download", exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get("kind") === "native-liked");
    await page.getByRole("button", { name: "Choose Liked songs" }).click();
    await page.getByText("9 songs selected", { exact: true }).waitFor();
    await shot("settings", "/app/settings");
    await shot("admin", "/app/manage");
    await page.getByRole("navigation", { name: "Admin navigation" }).getByRole("link", { name: "Reports", exact: true }).click();
    await page.getByText("Fictional lyrics issue", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Mark resolved", exact: true }).click();
    await page.getByRole("heading", { name: "Recently resolved" }).waitFor();
    await page.setViewportSize({ width: 320, height: 740 });
    await page.getByRole("navigation", { name: "Admin navigation" }).getByRole("link", { name: "Reports", exact: true }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Admin navigation fits a narrow phone");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await shot("jobs", "/app/manage?tab=jobs");
    await shot("analysis", "/app/manage?tab=analysis");
    await shot("workers", "/app/manage?tab=workers");
    await page.setViewportSize({ width: 390, height: 844 });
    await shot("mobile-player", "/app/now-playing");
    await shot("mobile-discover", "/app/search");
    await shot("mobile-charts", "/app/discover/charts/apple-us");
    await page.setViewportSize({ width: 320, height: 740 });
    await shot("mobile-small-discover", "/app/search");
    await shot("mobile-small-charts", "/app/discover/charts/apple-us");
    await page.keyboard.press("Tab");
    assert.ok(await page.evaluate(() => document.activeElement?.tagName !== "BODY"), "Keyboard navigation has a focusable destination");
    await page.locator("audio").evaluateAll((audio) => audio.forEach((element) => element.pause()));
    await page.waitForFunction(() => Array.from(document.querySelectorAll("audio")).every((audio) => audio.paused));
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("mint:private-session")));
    await page.waitForTimeout(500);
    await page.goto(`${base}/browse`);
    await context.clearCookies(); await page.setViewportSize({ width: 1440, height: 1000 });
    await shot("landing", "/"); await shot("browse", "/browse"); await shot("landing-stats", "/activity");
    await page.setViewportSize({ width: 390, height: 844 }); await shot("mobile-landing", "/");
    const unexpectedFailures = failures.filter((failure) =>
      !(historyAborts.length > 0 && failure.includes("Listening history write failed TypeError: Failed to fetch")));
    if (unexpectedFailures.length) console.error("Browser console diagnostics", unexpectedFailures);
    assert.deepEqual(unexpectedFailures, [], "No unexpected browser application errors");
    console.log("Browser flows passed: member/public boundary, native playback, navigation persistence, explicit acquisition/deduplication, poll-to-playable, chart-order skipping, 320px/mobile layouts and keyboard focus.");
  } finally { await browser.close(); }
}
gateway.close(); redis.disconnect(); await closeDb();
