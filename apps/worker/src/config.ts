import { numberEnv, optionalEnv } from "@mint/core/env";
import { youtubeGapMs } from "@mint/core/youtube-pace";

export const config = {
  musicDir: optionalEnv("MUSIC_DIR", "/music"),
  existingMusicDir: optionalEnv("EXISTING_MUSIC_DIR", "/existing-music"),
  get plexReadOnly() {
    return process.env.PLEX_READ_ONLY === "true";
  },
  stagingDir: optionalEnv("STAGING_DIR", "/data/staging"),
  blackholeTorrents: optionalEnv("BLACKHOLE_TORRENT_DIR", "/blackhole/torrents"),
  blackholeUsenet: optionalEnv("BLACKHOLE_NZB_DIR", "/blackhole/nzbs"),
  blackholeDownloads: optionalEnv("BLACKHOLE_DOWNLOAD_DIR", "/blackhole/downloads"),
  blackholeUsenetDownloads: optionalEnv("BLACKHOLE_NZB_DOWNLOAD_DIR", "/blackhole/usenet-downloads"),
  syncIntervalMin: numberEnv("SYNC_INTERVAL_MINUTES", 30),
  lidarrGrabTimeoutMs: numberEnv("LIDARR_GRAB_TIMEOUT_MINUTES", 5) * 60_000,
  lidarrTotalTimeoutMs: numberEnv("LIDARR_TOTAL_TIMEOUT_MINUTES", 45) * 60_000,
  plexScanTimeoutMs: numberEnv("PLEX_SCAN_TIMEOUT_MINUTES", 5) * 60_000,
  sonicTimeoutMs: numberEnv("PLEX_SONIC_TIMEOUT_HOURS", 6) * 3_600_000,
  concurrency: {
    acquire: numberEnv("ACQUIRE_CONCURRENCY", 4),
    finalize: numberEnv("FINALIZE_CONCURRENCY", 2),
    torbox: numberEnv("TORBOX_CONCURRENCY", 2),
  },
  /** YouTube imports run one at a time per worker process, with this pause between them. */
  youtubeImportGapMs: youtubeGapMs(process.env.YOUTUBE_IMPORT_GAP_SECONDS, 15),
  /** A getter: the token and section can be discovered after startup (see integrations.ts). */
  get plexEnabled() {
    return Boolean(process.env.PLEX_URL && process.env.PLEX_TOKEN && process.env.PLEX_MUSIC_SECTION_ID);
  },
  /** auto: hand YouTube rips to volunteer workers when any are online (or when no local Cobalt). */
  remoteMode: optionalEnv("REMOTE_DOWNLOADS", "auto") as "auto" | "always" | "never",
  /** Take a job back from the remote pool and rip it locally after this long without a taker. */
  remoteWaitMs: numberEnv("REMOTE_WAIT_MINUTES", 30) * 60_000,
  hubPort: numberEnv("HUB_PORT", 8090),
  maxUploadBytes: numberEnv("MAX_UPLOAD_MB", 200) * 1024 * 1024,
};
