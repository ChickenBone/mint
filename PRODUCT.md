# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
- **Members**: approved people who link their YouTube Music (Google) account. Mint mirrors their liked songs and chosen playlists into a self-hosted Plex library, and they listen in Plexamp. They use the dashboard to watch progress, manage what syncs, and browse what they own.
- **Admin (operator)**: runs the host server. Approves access requests, watches service health, and retries or cancels jobs.
- **Public visitors**: anyone on mint.chickenbone.dev. They see live library stats and the job pipeline, browse the library (each song links out to YouTube Music), and can request access. The site never plays audio.

## Product Purpose
Mint turns a person's YouTube Music likes into real files on a self-hosted server. It finds album-quality releases through Lidarr and TorBox, falls back to a self-hosted Cobalt rip from YouTube, tags the files, imports them into Plex, waits for Plex sonic analysis, and serves the result to Plexamp. The job is done when a song liked on a phone shows up in Plexamp without anyone touching it.

## Positioning
Mint is a single live pipeline from "liked" to "on my own server," and every step is visible in real time over WebSockets. The public front page shows the pipeline running.

## Operating Context
- Hosted at mint.chickenbone.dev with Docker Compose. Images are published to GHCR from GitHub Actions.
- Lidarr, TorBox (debrid), Cobalt, and Plex live on an internal network. The public app never talks to them directly; it uses Postgres and Redis queues.
- Approved members can listen inside Mint's persistent Plexamp-powered browser shell, or use the installed Plexamp app with a separate Plex invitation. Public pages remain browse-only.

## Capabilities and Constraints
- Access is by request only. A visitor submits a name, email, and password; the account stays inactive until an admin approves it.
- YouTube linking uses Google OAuth with the read-only YouTube Data API scope.
- There is one shared Plex music library. Each member has their own likes and playlists, which map to Plex playlists.
- Download order: MusicBrainz match, then Lidarr album search with the TorBox blackhole bridge, then a Cobalt audio fallback.
- Pipeline stages: queued, matching, searching, downloading, importing, tagging, scanning, analyzing (sonic), ready, failed.
- Cover art is a remote URL (Cover Art Archive or YouTube thumbnail). It is also embedded in the file for Plex.
- Existing Plex music can be indexed with a read-only original-folder mount and no Plex API writes. Likes reuse confidently matched originals; lossy originals may get a separately stored lossless-format upgrade, while originals remain untouched. Codec checks cannot establish spectral provenance.
- The NAS compose stack includes its own acquisition/finalization worker. Volunteer machines are optional and their counts do not describe the local worker.
- V2.6 adds full collection play/shuffle, member-local browser EQ/compression and real crossfades, synced/plain lyrics from keyless LRCLIB, and read-only Plex sonic recommendations restricted to playable indexed tracks. Proprietary Sweet Fades/native DSP is not reproduced; Plex sonic analysis/entitlements remain required.
- Android Chrome can install Mint as a standalone HTTPS PWA. Private pages, lyrics and audio are never service-worker cached; offline listening and guaranteed native-style background execution are not offered.

## Brand Commitments
- Name: **Mint**.
- The member app must feel like Spotify: a sidebar library, playable track tables, artwork-led music views and a persistent Mint player bar. Playback continues across member pages without rebuilding Plexamp's music interface.

## Evidence on Hand
- There are no users, testimonials, or metrics yet. All stats on the front page must come from the live database and must never be invented.

## Product Principles
1. Show the machine. Every job's stage and progress is visible, live.
2. Keep a hard wall between the public app and the media services.
3. Fully automatic once linked. Manual actions are for exceptions only.
4. Use album quality first and fall back to YouTube, and always label which source a file came from.
