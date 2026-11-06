# Playback, library and media decisions

## Large-library behavior

- Treat the library as a searchable backlog, not an unbounded page or browser-side metadata array.
- Preserve bounded recommendations and paginated browsing. Current catalog windows hydrate at most 100 entries.
- Play/Shuffle selects the complete matching collection, not only the visible page.
- Server-owned ID snapshots freeze queue membership/order; hydrate later windows progressively. Additions to the library must not inflate an existing queue.
- Shuffle must visit each queue occurrence once before repeat-all wraps. Deliberate duplicate song additions retain separate queue identities.
- Reorder/remove/clear upcoming without restarting the current song.
- Search should tolerate reordered words, prefixes, accents and conservative typos; do not require exact titles.

See `apps/web/src/lib/native-player.ts`, browser/catalog helpers and native-player tests before modifying queue semantics.

## Playback continuity and access

Preserve one native two-deck HTMLAudio/Web Audio engine across member navigation. Reload restores account-scoped queues paused, not autoplaying. Signing out, account changes and revocation must not leak playback or private state.

Original browser-supported audio streams unchanged. MP3 compatibility is an explicit private conversion cache; it must not replace original files. Codec/autoplay/background limitations need truthful messages, not hidden failure or guaranteed seamlessness claims.

Keep same-origin/blob media allowed by the initial document CSP so navigating from a public page does not retain a media-blocking policy. Authorization still belongs on private media endpoints.

## Artwork

Library artwork goes through `/api/artwork/{trackId}`. Plex album artwork is primary, preferring album/parent thumbs; saved public artwork, Cover Art Archive and available YouTube thumbnails are backups.

Stored public artwork URLs remain fallback metadata; do not overwrite them with a track proxy path. Shared views project the public endpoint. Album cards/hero mosaics must group by album identity, not produce duplicates for every per-track artwork URL.

Preserve bounded caches, concurrent request coalescing, short failure cooldowns, stale-cover recovery and later Plex retry. Fetches need bounded bytes/time, validated redirects and safe raster content. Keep Plex tokens and URLs private.

Explicit custom/imported playlist artwork has separate semantics; do not indiscriminately replace it. Complete failure shows the shared neutral artwork tile.

## DSP, analysis and lyrics

Mint Smart Fades are independent, measured transitions, not proprietary Sweet Fades. Preserve Off/Fixed/Smart modes, album-safe boundaries, repeat-one handling and explicit fallback when analysis is absent.

Loudness normalization uses measured LUFS/true peak and bounded headroom. EQ/overlaps must not introduce clipping by discarding existing headroom safeguards. Compression is not a guaranteed brick-wall limiter.

Mint analysis measures fingerprints, loudness, silence, waveform, estimated tempo/key and descriptor similarity. Preserve version/provenance/confidence; metadata matching is not sonic similarity, and descriptors are not neural embeddings.

LRCLIB and Lyrics.ovh lyrics are compared on demand, not library-wide. Prefer actual enhanced-LRC word timing, then line sync, then plain text; never synthesize word timing from line duration. Show source/timing capability and partial provider failures, and allow choosing an available source. Keep instrumental/no-match/error states, manual-follow behavior and personal LRCLIB match/timing corrections. A corrected match takes precedence over automatic ranking. Never send audio, private paths or credentials to a lyrics provider. Providers remain bounded, Redis-cached and rate-limited; LRCLIB cooldown does not block the independent fallback.

## Collections, devices and offline

Preserve native playlists, duplicates/order, smart rules, collaboration, folders/pins and separate source-managed imports. Copying an import creates an editable Mint copy, never upstream edits.

Preserve private sessions/history deletion. Deleted/private episodes must not be submitted later by stale client work.

Device handoff requires an awake connected destination and successful playback acknowledgement before pausing the source. Parties have one output device, not synchronized multi-device audio. See [devices](../docs/devices.md).

Offline music is explicitly downloaded, account-scoped IndexedDB content. The service worker caches only the generic offline shell, not authenticated pages/APIs. Preserve storage budgets, cancellation/retry, access renewal and logout cleanup. Browser eviction and Android suspension remain possible; disconnected audio cannot be remotely revoked.
