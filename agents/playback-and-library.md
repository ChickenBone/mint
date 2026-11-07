# Playback, library and media decisions

## Large-library behavior

- Treat the library as a searchable backlog, not an unbounded page or browser-side metadata array.
- Preserve bounded recommendations and paginated browsing. Current catalog windows hydrate at most 100 entries.
- Play/Shuffle selects the complete matching collection, not only the visible page.
- Server-owned ID snapshots freeze queue membership/order; hydrate later windows progressively. Additions to the library must not inflate an existing queue.
- Shuffle must visit each queue occurrence once before repeat-all wraps. Deliberate duplicate song additions retain separate queue identities.
- Previous restarts the current song after three seconds; before that, repeat-all wraps from the first occurrence to the last. Revalidate restored queue windows before selecting.
- Reorder/remove/clear upcoming without restarting the current song.
- Search should tolerate reordered words, prefixes, accents and conservative typos; do not require exact titles.

See `apps/web/src/lib/native-player.ts`, browser/catalog helpers and native-player tests before modifying queue semantics.

Here, the historical "native player" means Mint's independent **browser**
engine, not Expo. The [mobile playback card](domains/mobile-playback.md) and
[native playback notes](../docs/mobile-playback.md) own the Expo engine. Reuse
`@mint/client` queue/catalog contracts without assuming browser DSP or device
bridge parity. Native metadata must use the selected public Mint server's
artwork URL; relative browser URLs are not proof of Android lockscreen artwork.
The [mobile player card](domains/mobile-player.md) owns presentation separately;
screen-only work starts with its focused guide/tests, not this browser engine
guide. `npm run agents -- map mobile-playback` and `map mobile-player` show the
current contract seam.

## Playback continuity and access

Preserve one native two-deck HTMLAudio/Web Audio engine across member navigation. Reload restores account-scoped queues paused, not autoplaying. Signing out, account changes and revocation must not leak playback or private state.

The mini-player and Now Playing are one presentation surface. Expansion/collapse only changes presentation; it must not issue playback commands or remount the engine. Pointer gestures track the finger/mouse continuously, settle by recent release velocity or distance, and remain interruptible/reversible. Keep transport, seek, volume and menu targets outside drag activation. The compact dock has no separate grab bar or row; its non-control areas and the expanded header, artwork and metadata accept dragging while links retain taps. Queue and lyrics retain native scrolling; downward collapse from their content is available only at scroll top, with the header as the reliable drag region. Keep the moving cover outside content clipping ancestors, hide other cover copies during motion, and restore the in-content cover at rest for normal scrolling and interaction. Measure artwork geometry before gestures/settling and on viewport or track changes, not on pointer moves. Reduced motion keeps direct tracking and skips spring settling. The `/app/now-playing` deep link remains supported; Back and Escape dismiss without losing the underlying route or its scroll position.

Original browser-supported audio streams unchanged. MP3 compatibility is an explicit private conversion cache; it must not replace original files. Codec/autoplay/background limitations need truthful messages, not hidden failure or guaranteed seamlessness claims.

Keep same-origin/blob media allowed by the initial document CSP so navigating from a public page does not retain a media-blocking policy. Authorization still belongs on private media endpoints.

## Artwork

Library artwork goes through `/api/artwork/{trackId}`. Plex album artwork is primary, preferring album/parent thumbs; saved public artwork, Cover Art Archive and available YouTube thumbnails are backups.

Artist portraits use Plex `grandparentThumb` only, through `/api/artwork/{trackId}?variant=artist`. They share the signed track-specific artwork proxy, validated Plex paths, private token handling, bounded image cache, and coalescing. Do not substitute album covers or public album-art sources for portraits; absent Plex portraits use the shared neutral tile.

Artist detail metadata is fetched by the pipeline worker's bounded background queue. Resolve MusicBrainz identities only on exact normalized names or existing track MBIDs; ambiguous names stay unresolved. Profiles may include MusicBrainz artist type/relations, attributed Wikipedia lead summaries, and ListenBrainz community listen/listener counts and similar artists. Keep each source explicit; these counts are not global popularity, and failures must remain retryable/visible. The queue reads metadata only and never opens audio files or changes Plex.

Stored public artwork URLs remain fallback metadata; do not overwrite them with a track proxy path. Shared views project the public endpoint. Album cards/hero mosaics must group by album identity, not produce duplicates for every per-track artwork URL.

Preserve bounded caches, concurrent request coalescing, short failure cooldowns, stale-cover recovery and later Plex retry. Fetches need bounded bytes/time, validated redirects and safe raster content. Keep Plex tokens and URLs private.

Approved public Cover Art Archive resolution/images and YouTube thumbnails reuse
the shared server-only public-read cache; private Plex artwork fetches retain
their existing separate path and 32 MiB artwork LRU. Public image reads validate
bounded raster content and allowed redirects, including approved archive hosts.
Artwork responses expose cache status/age without provider credentials; stale
fallbacks do not permanently suppress later Plex retry. Artist metadata adapters
also reuse bounded MusicBrainz/Wikidata/Wikipedia/ListenBrainz reads. Full coverage
and retention limits live in [the cache contract](architecture.md#server-side-public-read-caches);
direct chart image URLs are not newly backend-proxied.

Explicit custom/imported playlist artwork has separate semantics; do not indiscriminately replace it. Complete failure shows the shared neutral artwork tile.

## DSP, analysis and lyrics

Mint Smart Fades are independent, measured transitions, not proprietary Sweet Fades. Preserve Off/Fixed/Smart modes, album-safe boundaries, repeat-one handling and explicit fallback when analysis is absent. In `v2` (`mint-dsp-v2`), Smart Fades combine structural cue points (`introEndSec`, `outroStartSec`), MixRamp equal-loudness contours (`fadeInContourDb`, `fadeOutContourDb`), BPM/beatgrid phrase alignment (`4`, `8`, or `16` beats), Camelot harmonic wheel scoring (`exact`, `relative`, `adjacent`, `clash`), and vocal clash protection while falling back cleanly to `v1` fields for `v1`-analyzed tracks.

Loudness normalization uses measured LUFS/true peak, LRA-aware gain clamping, and bounded headroom across `"auto"`, `"track"`, and `"album"` modes (`normalizeMode`). Playback DSP (`BrowserDSP`) includes a 10-band EQ (`Flat`, `Warm`, `Vocal`, `Low listening`, `Bass boost`, `Acoustic`, `Electronic`, `Late night`), Fletcher-Munson equal-loudness contour (`loudnessContour`), headphone crossfeed / stereo width (`stereoMode`), dynamic range compression, and a post-EQ true-peak lookahead soft limiter (`-0.3 dBFS`).

Mint analysis (`mint-dsp-v2`, `16 kHz` streaming decode) measures SHA-256 fingerprints, EBU R128 loudness (`integratedLufs`, `truePeakDbtp`, `lraLu`, `shortTermMaxLufs`, `crestFactorDb`), silence, 256-bin waveform, MixRamp fade contours, beatgrid tempo/stability, HPCP key + Camelot/Open Key notation, 12-band Bark energy, 13 MFCCs, genre/sub-genre + mood + vocal/instrumental classifications, and 64-d `audio-embedding-v2` similarity vectors. Existing `v1` (`mint-dsp-v1`) records remain valid via a discriminated union (`analysisV1Schema | analysisV2Schema`) until upgraded or reprocessed. Library filters and Smart Playlists can filter by `genre`, `mood`, `minBpm`, `maxBpm`, `camelotKey`, and `vocalType`.

LRCLIB and Lyrics.ovh lyrics are compared on demand, not library-wide. Prefer actual enhanced-LRC word timing, then line sync, then plain text; never synthesize word timing from line duration. Source/timing details, partial provider failures, source choice and personal LRCLIB match/timing corrections are available in the admin lyrics details. Keep instrumental/no-match/error states and manual-follow behavior; listeners can report an issue to admins. A corrected match takes precedence over automatic ranking. Never send audio, private paths or credentials to a lyrics provider. Providers remain bounded, Redis-cached and rate-limited; LRCLIB cooldown does not block the independent fallback.

LRCLIB get/search/by-ID and Lyrics.ovh now share server-only cache plumbing with
explicit fresh/stale/negative/error policies. Stale lyrics carry warnings; only
validated no-match/404 results use negative caching, never provider failures.
Personal match/timing corrections are applied outside the shared public provider
cache, and authenticated lyric API responses remain private/no-store. See the
[read coverage and retention table](architecture.md#server-side-public-read-caches);
this does not introduce offline/service-worker lyric caching.

## Collections, devices and offline

Preserve native playlists, duplicates/order, smart rules, collaboration, folders/pins and separate source-managed imports. Copying an import creates an editable Mint copy, never upstream edits.

Preserve private sessions/history deletion. Deleted/private episodes must not be submitted later by stale client work.

Device handoff requires an awake connected destination and successful playback acknowledgement before pausing the source. Parties have one output device, not synchronized multi-device audio. See [devices](../docs/devices.md).

Browser offline music is explicitly downloaded, account-scoped IndexedDB content. The service worker caches only the generic offline shell, not authenticated pages/APIs. Expo uses its platform-specific account/server-scoped offline store, not the browser service worker. Preserve storage budgets, cancellation/retry, access renewal and logout cleanup on both surfaces. Browser eviction and Android suspension remain possible; disconnected audio cannot be remotely revoked.
