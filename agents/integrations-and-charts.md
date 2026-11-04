# Providers, acquisition and charts

## Existing-library safety

Index Plex metadata in bounded pages, validate the music section and map Plex paths to the worker's read-only mount. A folder merely existing is not proof that the mapping or migration destination is correct.

Match originals conservatively using artist/title, compatible album/version metadata and duration. Ambiguous editions must not be silently reused or replaced. Confident lossy-to-lossless upgrades are stored separately and verified with media inspection; a FLAC codec is not proof of lossless source provenance.

Read-only Plex mode must not claim/create libraries, scan, write playlists or modify original media. Re-indexing must not erase originals or accepted separate upgrades.

## Provider responsibilities

- **Google/YouTube Music:** read-only OAuth import of music likes and selected playlists. Do not post or edit upstream content. Existing-library indexing should complete before synchronization triggers acquisition.
- **Spotify:** optional read-only playlist metadata and confident local matches, preserving order/repeats. Do not stream Spotify audio, use its analysis API or automatically download missing entries. Current developer-app restrictions require verification; see [Spotify](../docs/spotify.md).
- **MusicBrainz:** recording/release matching with conservative identity validation and instance rate limits. Ordinary local search should not send queries upstream; explicit missing-music/chart resolution may.
- **Lidarr/TorBox:** configured release acquisition first, with optional Prowlarr/indexers. TorBox provider access does not supply a searchable Usenet indexer account.
- **Cobalt:** self-hosted eligible YouTube audio fallback. Source availability and rights are not guaranteed. Do not implement CAPTCHA/entitlement bypasses or force incorrect sources.

Keep add-only integration configuration from overwriting operator-maintained settings. Log/test unavailable sources honestly; do not advertise broken indexers as configured successfully.

## Current chart implementation

Read [docs/charts.md](../docs/charts.md) and `apps/web/src/lib/chart-*.ts` / `charts.ts`.

| Source | Honest scope |
| --- | --- |
| Apple Music RSS + batched metadata lookup | Country storefront Top 50, including US; not worldwide or verified independent genre rankings |
| ListenBrainz | Weekly worldwide community listening rankings; not worldwide industry sales/streams |
| Audius | Platform weekly trending and supported genre collections; not the entire music market |

Do not fabricate a global chart by aggregating countries, call genre labels independent rankings, or substitute preview audio for local availability.

Provider coverage, licensing, availability, authentication and rate limits must be researched before adding/changing a source. Ask before introducing paid requirements or a material coverage compromise. Public metadata access is not permission to download audio.

## Chart contracts and resilience

- Typed server-side API: `GET /api/charts`; approved-member acquisition: `POST /api/charts/request`.
- Bound charts to 50 entries and frontend pages to 25; retain rank/order across revision-aware pagination.
- Preserve shared Redis caching, refresh leases, per-provider throttles, bounded responses/timeouts and Retry-After handling.
- Show provider, territory/audience, actual period, publication time when supplied and Mint check time separately.
- Distinguish empty results, disabled configuration, unavailable provider/Redis, stale cache and old provider publication.
- Keep provider transport/credentials and library matching server-side.

## Local availability and explicit acquisition

Match recording identities, not merely display strings. Preserve live/remix/remaster/version qualifiers, duration checks and recording identifiers. Overfull/conflicting candidates stay ambiguous.

Available songs use native player/queue behavior and Plex-first art. Missing songs are muted, with a labeled **Add to library** action. Requested/processing/failed/ambiguous states remain distinct; completion becomes playable through realtime invalidation and visible-page polling.

**Play local songs** preserves chart rank order and explains skips. It never acquires songs. Only an explicit authorized member request enters acquisition; public visitors cannot submit requests or receive playback authorization.

Reuse signed account-bound recording resolution, ownership, deduplication and the existing job lifecycle. Pin a selected recording through downstream matching so acquisition cannot substitute a same-name edition. If identity/source is insufficient, expose a resolution flow instead of success-shaped queueing.

Recommendations and Spotify sync do not silently acquire music. YouTube sync's explicitly enabled acquisition and a member's explicit missing-song/chart request are different product flows.
