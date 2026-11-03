import { numberEnv, optionalEnv } from "@mint/core/env";

export const config = {
  musicDir: optionalEnv("MUSIC_DIR", "/music"),
  stagingDir: optionalEnv("STAGING_DIR", "/data/staging"),
  blackholeTorrents: optionalEnv("BLACKHOLE_TORRENT_DIR", "/blackhole/torrents"),
  blackholeDownloads: optionalEnv("BLACKHOLE_DOWNLOAD_DIR", "/blackhole/downloads"),
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
  plexEnabled: Boolean(process.env.PLEX_URL && process.env.PLEX_TOKEN && process.env.PLEX_MUSIC_SECTION_ID),
  /** auto: hand YouTube rips to volunteer workers when any are online (or when no local Cobalt). */
  remoteMode: optionalEnv("REMOTE_DOWNLOADS", "auto") as "auto" | "always" | "never",
  /** Take a job back from the remote pool and rip it locally after this long without a taker. */
  remoteWaitMs: numberEnv("REMOTE_WAIT_MINUTES", 30) * 60_000,
  hubPort: numberEnv("HUB_PORT", 8090),
  maxUploadBytes: numberEnv("MAX_UPLOAD_MB", 200) * 1024 * 1024,
};
