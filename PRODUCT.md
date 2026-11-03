# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
- **Members**: approved people who link their YouTube Music (Google) account. Mint mirrors their liked songs and chosen playlists into a self-hosted Plex library, and they listen in Mint. They use the dashboard to watch progress, manage what syncs, and browse what they own.
- **Admin (operator)**: runs the host server. Approves access requests, watches service health, and retries or cancels jobs.
- **Public visitors**: anyone on mint.chickenbone.dev. They see live library stats and the job pipeline, browse the library (each song links out to YouTube Music), and can request access. The site never plays audio.

## Product Purpose
Mint turns a person's YouTube Music likes into real files on a self-hosted server. It finds album-quality releases through Lidarr and TorBox, falls back to a self-hosted Cobalt rip from YouTube, tags the files, and imports them into Plex. Mint owns the listening experience; Plex remains the private library server. The job is done when a song liked on a phone is available to listen to without anyone touching it.

## Positioning
Mint is a single live pipeline from "liked" to "on my own server," and every step is visible in real time over WebSockets. The public front page shows the pipeline running.

## Operating Context
- Hosted at mint.chickenbone.dev with Docker Compose. Images are published to GHCR from GitHub Actions.
- Lidarr, TorBox (debrid), Cobalt, and Plex live on an internal network. The public app never talks to them directly; it uses Postgres and Redis queues.
- Approved members listen inside Mint's persistent, independently implemented browser player, or optionally use an external Plex client with a separate Plex invitation. Public pages remain browse-only.

## Capabilities and Constraints
- Access is by request only. A visitor submits a name, email, and password; the account stays inactive until an admin approves it.
- YouTube linking uses Google OAuth with the read-only YouTube Data API scope.
- There is one shared Plex music library. Each member has their own likes and playlists, which map to Plex playlists.
- Download order: MusicBrainz match, then Lidarr album search with the TorBox blackhole bridge, then a Cobalt audio fallback.
- Pipeline stages: queued, matching, searching, downloading, importing, tagging, scanning, analyzing (sonic), ready, failed.
- Cover art is a remote URL (Cover Art Archive or YouTube thumbnail). It is also embedded in the file for Plex.
- Existing Plex music can be indexed with a read-only original-folder mount and no Plex API writes. Likes reuse confidently matched originals; lossy originals may get a separately stored lossless-format upgrade, while originals remain untouched. Codec checks cannot establish spectral provenance.
- The NAS compose stack includes its own acquisition/finalization worker. Volunteer machines are optional and their counts do not describe the local worker.
- The V3 foundation replaces the embedded Plexamp UI, assets, module patches and compatibility APIs entirely. Mint owns catalog browsing, artist/album views, search, collection play/shuffle, persistent queues, member-local browser EQ/compression and fixed-duration crossfades, lyrics and now-playing. These need no Plex Pass. Smart Fades and Mint sonic analysis remain approved work, not implemented capabilities; no proprietary engine or entitlement spoofing is used.
- Android Chrome can install Mint as a standalone HTTPS PWA. Private pages, lyrics and audio are never service-worker cached; offline listening and guaranteed native-style background execution are not offered.

## Brand Commitments
- Name: **Mint**.
- The member app must feel like Spotify: a sidebar library, playable track tables, artwork-led music views and persistent playback. Mint owns the entire interface and audio engine; navigation never remounts playback. Keep the existing dark/Figtree/mint visual identity and deliberate reduced-motion-aware animation.

## Evidence on Hand
- There are no users, testimonials, or metrics yet. All stats on the front page must come from the live database and must never be invented.

## Product Principles
1. Show the machine. Every job's stage and progress is visible, live.
2. Keep a hard wall between the public app and the media services.
3. Fully automatic once linked. Manual actions are for exceptions only.
4. Use album quality first and fall back to YouTube, and always label which source a file came from.

## Approved V3.1 / V3.5 scope

The user explicitly approved this scope and staged implementation. The native foundation ships as V3.1; all remaining launch requirements belong to V3.5. V3.5 is complete only after all remaining milestones are delivered and verified. Later-V3 deferrals below remain outside V3.5.

1. **Native foundation:** zero embedded Plexamp runtime/build dependencies; native library/search/artist/album/playlist browsing; persistent transport, full-collection queue/shuffle/repeat, ordering, restoration, and member-private media access.
2. **Analysis and Smart Fades:** Mint-owned, versioned/fingerprinted loudness/peak, silence, waveform, tempo/key and similarity analysis, supplemented by capability-verified Plex data. Lightweight work stays on the NAS; heavy similarity analysis can run on an optional separately authenticated Docker worker. Add scheduling, concurrency/resource limits, resumable backfills, provenance/confidence, coverage and actionable diagnostics. Content-aware fades choose safe overlap/gain curves, normalize loudness with peak headroom, preserve continuous albums and expose explicit fallback/Off modes. Verify direct-play/gapless support and add controlled transcoding where required.
3. **Complete listening platform:** track/artist/album radio, multi-seed mixes, personal mixes, rediscovery, recently added, repetition/diversity/taste controls and understandable recommendations. Native editable playlists support duplicate tracks, artwork, folders/pinning and smart rules. Source-managed YouTube imports remain separate; copying creates an editable Mint playlist, never upstream writes. Add owner/editor collaboration and conflict-safe changes, listening history/private sessions/deletion, lyrics matching correction and richer metadata/filtering.
4. **Launch completion:** opt-in party sessions/shared queue with host controls and a single playback device; named devices, remote transport/volume/queue and explicit track/position/queue handoff. Android Chrome PWA offline track/album/playlist downloads with progress/cancellation/retry, account-scoped storage, downloaded-only browsing, storage limits/removal and access revalidation/logout cleanup. Preserve public/private boundaries and read-only originals; complete diagnostics, migrations and Docker/GHCR/CI upgrade delivery.

**Deferred until later V3 releases:** DJ-style beat/phrase/key-aware mixing with pitch-preserving tempo adjustment and editable/saved transitions; synchronized multi-device audio; native Android playback/download service and potential Android Auto; optional visualizers, richer reports and extra integrations.

**Constraints:** no Spotify analysis API dependency, mandatory GPU or paid analysis service. Validate analyzer/model licenses and resource needs before adoption. Never label metadata matching as sonic similarity or assume raw Plex embedding export. PWA storage can be evicted and background execution can be suspended. Downloaded audio cannot be remotely revoked while disconnected. Device control requires an awake, connected client; it does not remotely awaken a closed browser. Recommendations do not automatically trigger acquisition.
