import { readFile } from "node:fs/promises";
import path from "node:path";
import { optionalEnv } from "@mint/core/env";
import { config } from "./config";
import { log } from "./log";
import * as lidarr from "./services/lidarr";
import * as plex from "./services/plex";

/**
 * Zero-config wiring for the bundled Plex and Lidarr. Runs at startup and on every health tick until
 * everything it can do is done, so the order containers come up in doesn't matter:
 *
 *  - Plex: reads the server token from Preferences.xml (written once the server is claimed) and
 *    finds or creates the Music library at /music.
 *  - Lidarr: reads the API key from config.xml, adds the /music root folder and the TorBox
 *    blackhole download client.
 *
 * Anything set explicitly in the environment wins. Returns setup notes for the admin page.
 */

const PLEX_PREFS = "Library/Application Support/Plex Media Server/Preferences.xml";
let lidarrReady = false;

async function readAttr(file: string, re: RegExp) {
  const xml = await readFile(file, "utf8").catch(() => null);
  return xml?.match(re)?.[1] ?? null;
}

async function wirePlex(notes: string[]) {
  if (!process.env.PLEX_URL) return;
  if (!process.env.PLEX_TOKEN) {
    const token = await readAttr(path.join(optionalEnv("PLEX_CONFIG_DIR", "/plex-config"), PLEX_PREFS), /PlexOnlineToken="([^"]+)"/);
    if (!token) {
      notes.push("Plex isn't claimed yet. Get a code from plex.tv/claim, set PLEX_CLAIM in .env and run `docker compose up -d plex` within 4 minutes. Or set PLEX_TOKEN.");
      return;
    }
    process.env.PLEX_TOKEN = token;
    log.info("found Plex token in Preferences.xml");
  }
  if (process.env.PLEX_MUSIC_SECTION_ID) return;
  const location = optionalEnv("PLEX_MUSIC_DIR", config.musicDir);
  const findSection = async () =>
    (await plex.listSections()).find((s) => s.type === "artist" && s.Location?.some((l) => l.path.replace(/\/$/, "") === location));
  let section = await findSection();
  if (!section) {
    await plex.createMusicSection(location);
    log.info({ location }, "created Plex Music library");
    section = await findSection();
  }
  if (section) process.env.PLEX_MUSIC_SECTION_ID = section.key;
  else notes.push(`Couldn't create a Plex Music library at ${location}. Create one in Plex and set PLEX_MUSIC_SECTION_ID.`);
}

interface Field {
  name: string;
  value?: unknown;
}
interface ClientSchema {
  implementation: string;
  fields: Field[];
  [k: string]: unknown;
}

async function wireLidarr(notes: string[]) {
  if (!process.env.LIDARR_URL || process.env.LIDARR_ENABLED === "false") return;
  if (!process.env.LIDARR_API_KEY) {
    const key = await readAttr(path.join(optionalEnv("LIDARR_CONFIG_DIR", "/lidarr-config"), "config.xml"), /<ApiKey>([^<]+)<\/ApiKey>/);
    if (!key) return; // Lidarr hasn't finished its first start yet.
    process.env.LIDARR_API_KEY = key;
    log.info("found Lidarr API key in config.xml");
  }
  if (!process.env.TORBOX_API_KEY && process.env.LIDARR_ENABLED !== "true") {
    notes.push("Lidarr is off because TORBOX_API_KEY isn't set. Every song is ripped from YouTube with Cobalt.");
    return;
  }
  if (lidarrReady) return;

  const rootPath = optionalEnv("LIDARR_ROOT_FOLDER", config.musicDir);
  const roots = await lidarr.api<Array<{ path: string }>>("/rootfolder", { timeoutMs: 5000, retries: 0 });
  if (!roots.some((r) => r.path.replace(/\/$/, "") === rootPath)) {
    const [qps, mps] = await Promise.all([lidarr.api<Array<{ id: number }>>("/qualityprofile"), lidarr.api<Array<{ id: number }>>("/metadataprofile")]);
    await lidarr.api("/rootfolder", {
      method: "POST",
      body: {
        name: "Music",
        path: rootPath,
        defaultQualityProfileId: qps[0]?.id,
        defaultMetadataProfileId: mps[0]?.id,
        defaultMonitorOption: "none",
        defaultNewItemMonitorOption: "none",
        defaultTags: [],
      },
    });
    log.info({ rootPath }, "added Lidarr root folder");
  }

  const clients = await lidarr.api<ClientSchema[]>("/downloadclient");
  if (!clients.some((c) => c.implementation === "TorrentBlackhole")) {
    const schema = (await lidarr.api<ClientSchema[]>("/downloadclient/schema")).find((c) => c.implementation === "TorrentBlackhole");
    if (!schema) throw new Error("Lidarr has no Torrent Blackhole download client");
    const values: Record<string, unknown> = {
      torrentFolder: config.blackholeTorrents,
      watchFolder: config.blackholeDownloads,
      saveMagnetFiles: true,
      magnetFileExtension: ".magnet",
      readOnly: false,
    };
    await lidarr.api("/downloadclient", {
      method: "POST",
      body: {
        ...schema,
        name: "TorBox (Mint)",
        enable: true,
        priority: 1,
        removeCompletedDownloads: true,
        removeFailedDownloads: true,
        tags: [],
        fields: schema.fields.map((f) => (f.name in values ? { ...f, value: values[f.name] } : f)),
      },
    });
    log.info("added TorBox blackhole download client to Lidarr");
  }

  const indexers = await lidarr.api<unknown[]>("/indexer");
  if (!indexers.length) notes.push("Lidarr has no indexers, so it can't find releases. Add some in Lidarr (or Prowlarr). Until then songs come from YouTube.");
  else lidarrReady = true;
}

export async function wireIntegrations(): Promise<string[]> {
  const notes: string[] = [];
  for (const [name, step] of [
    ["Plex", wirePlex],
    ["Lidarr", wireLidarr],
  ] as const) {
    try {
      await step(notes);
    } catch (err) {
      log.debug({ err }, `${name} auto-setup not ready yet`);
      notes.push(`${name} isn't answering yet. It can take a minute on first start.`);
    }
  }
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    notes.push("Members can't link YouTube Music until GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.");
  }
  return notes;
}
