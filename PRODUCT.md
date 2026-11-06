# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
- **Members**: approved people who listen to the shared library in Mint, discover music and manage their own likes and playlists, and can report problems to the admins. Linking another service is not required for listening.
- **Admin (operator)**: runs the host server. Approves access requests, reviews and resolves member issue reports, watches service health, and retries or cancels jobs.
- **Public visitors**: browse library metadata, artwork and chart availability, and request access. They cannot play audio or request acquisition. Library activity remains available separately from everyday browsing.

## Product Purpose
Mint is a self-hosted listening service for a shared music library. Members can find and play music, build personal collections and discover something new without having to understand how the server works. Mint owns the listening experience; Plex remains a private library server. Acquisition and library maintenance support listening rather than defining it.

## Positioning
Mint is a self-hosted listening service: private files, personal collections and discovery in one cohesive player. Its acquisition pipeline remains observable in management, not the organizing principle of listening.

## Operating Context
- Self-hosted with Docker Compose. Images are published to GHCR from GitHub Actions.
- Lidarr, TorBox (debrid), Cobalt, and Plex live on an internal network. The public app never talks to them directly; it uses Postgres and Redis queues.
- Approved members listen inside Mint's persistent, independently implemented browser player, or optionally use an external Plex client with a separate Plex invitation. Public pages remain browse-only.

## Capabilities and Constraints
- Access is by request only. A visitor submits a name, email, and password; the account stays inactive until an admin approves it.
- YouTube linking uses Google OAuth with the read-only YouTube Data API scope.
- There is one shared Plex music library. Each member has their own Mint likes and playlists; source-managed imports retain their distinct ownership and are not written upstream.
- Download order: MusicBrainz match, then Lidarr album search with the TorBox blackhole bridge, then a Cobalt audio fallback.
- Pipeline stages: queued, matching, searching, downloading, importing, tagging, scanning, analyzing (sonic), ready, failed.
- Cover art is a remote URL (Cover Art Archive or YouTube thumbnail). It is also embedded in the file for Plex.
- Existing Plex music can be indexed with a read-only original-folder mount and no Plex API writes. Likes reuse confidently matched originals; lossy originals may get a separately stored lossless-format upgrade, while originals remain untouched. Codec checks cannot establish spectral provenance.
- The NAS compose stack includes its own acquisition/finalization worker. Volunteer machines are optional and their counts do not describe the local worker.
- V3.1 removed the embedded Plexamp UI, assets, patches and compatibility APIs entirely. V3.5 adds Mint-owned measured analysis, content-aware Smart Fades/normalization, native collaborative/smart playlists, discovery, private listening history, connected device handoff and opt-in parties. These need no Plex Pass; no proprietary engine or entitlement spoofing is used. Audio-descriptor similarity is not a neural model; tempo and key have explicit estimate confidence.
- Android Chrome can install Mint as a standalone HTTPS PWA. Its service worker caches only a generic, account-free offline player shell. Explicit account-scoped audio downloads live in IndexedDB with device storage controls, seven-day renewal and logout cleanup. Authenticated HTML, API responses and lyrics are not service-worker cached. Android can suspend background work or evict browser storage; native-style background guarantees are not offered.
- Massive libraries are a searchable backlog, not the default homepage. Recommendations are bounded; full matching collections use frozen server-side ID queues and progressive 100-song metadata windows. Search accepts reordered words, accents, prefixes and conservative typos. Explicit signed MusicBrainz recording requests feed existing acquisition; external sources/configuration remain necessary.
- Optional Spotify OAuth mirrors accessible playlist metadata read-only, preserves order/duplicates and plays only confidently matched local Plex music. Missing/ambiguous/unavailable songs remain visible and never automatically download. Spotify's account, app approval and current development-mode restrictions apply; its audio and analysis APIs are not used.

## Brand Commitments
- Name: **Mint**.
- Mint should feel immediately familiar to listeners of Spotify and Apple Music: music, search, playlists and liked songs lead; operational tools stay in a separate admin area. Use Mint branding and independently implemented UI and assets. Desktop and mobile must make the primary listening flow easy to discover. Mint owns the interface and audio engine; navigation never remounts playback.

## Evidence on Hand
- There are no users, testimonials, or metrics yet. All stats on the front page must come from the live database and must never be invented.

## Product Principles
1. Music first, machinery within reach. Every job's progress and failure remains visible in management.
2. Keep a hard wall between the public app and the media services.
3. Keep setup and ordinary listening simple; provider connections are optional and operational actions belong in management.
4. Preserve source and acquisition details where they are needed for informed choices and troubleshooting.

## Consumer-first direction

The current direction is a consumer-focused music service with a familiar commercial music-app interface and an admin-only area in the same application. Ordinary controls use listener language such as "Liked songs" and "Create playlist", not redundant Mint qualifiers. Existing provider connections and data are preserved, but provider sync should not organize the consumer experience. YouTube playlist import remains supported. A self-hosted MusicBrainz mirror is optional, with public service fallback; it must not become a mandatory multi-gigabyte install. Chart sources must be honest about scope and respect their terms. Feature parity with commercial services is an aspiration, not a claim that unimplemented capabilities exist.

## Approved V3.1 / V3.5 scope

These are historical scope decisions, not evidence that every milestone has shipped or a replacement for the consumer-first direction above.

1. **Native foundation:** zero embedded Plexamp runtime/build dependencies; native library/search/artist/album/playlist browsing; persistent transport, full-collection queue/shuffle/repeat, ordering, restoration, and member-private media access.
2. **Analysis and Smart Fades:** Mint-owned, versioned/fingerprinted loudness/peak, silence, waveform, tempo/key and similarity analysis, supplemented by capability-verified Plex data. Lightweight work stays on the NAS; heavy similarity analysis can run on an optional separately authenticated Docker worker. Add scheduling, concurrency/resource limits, resumable backfills, provenance/confidence, coverage and actionable diagnostics. Content-aware fades choose safe overlap/gain curves, normalize loudness with peak headroom, preserve continuous albums and expose explicit fallback/Off modes. Verify direct-play/gapless support and add controlled transcoding where required.
3. **Complete listening platform:** track/artist/album radio, multi-seed mixes, personal mixes, rediscovery, recently added, repetition/diversity/taste controls and understandable recommendations. Native editable playlists support duplicate tracks, artwork, folders/pinning and smart rules. Source-managed YouTube imports remain separate; copying creates an editable Mint playlist, never upstream writes. Add owner/editor collaboration and conflict-safe changes, listening history/private sessions/deletion, lyrics matching correction and richer metadata/filtering.
4. **Launch completion:** opt-in party sessions/shared queue with host controls and a single playback device; named devices, remote transport/volume/queue and explicit track/position/queue handoff. Android Chrome PWA offline track/album/playlist downloads with progress/cancellation/retry, account-scoped storage, downloaded-only browsing, storage limits/removal and access revalidation/logout cleanup. Preserve public/private boundaries and read-only originals; complete diagnostics, migrations and Docker/GHCR/CI upgrade delivery.

**Deferred until later V3 releases:** DJ-style beat/phrase/key-aware mixing with pitch-preserving tempo adjustment and editable/saved transitions; synchronized multi-device audio; native Android playback/download service and potential Android Auto; optional visualizers, richer reports and extra integrations.

**Constraints:** no Spotify analysis API dependency, mandatory GPU or paid analysis service. Validate analyzer/model licenses and resource needs before adoption. Never label metadata matching as sonic similarity or assume raw Plex embedding export. PWA storage can be evicted and background execution can be suspended. Downloaded audio cannot be remotely revoked while disconnected. Device control requires an awake, connected client; it does not remotely awaken a closed browser. Recommendations do not automatically trigger acquisition.
