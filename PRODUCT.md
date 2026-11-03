# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
- **Members**: approved people who link their YouTube Music (Google) account. Mint mirrors their liked songs and chosen playlists into a self-hosted Plex library, and they listen in Plexamp. They use the dashboard to watch progress, manage what syncs, and browse what they own.
- **Admin (operator)**: runs the host server. Approves access requests, watches service health, and retries or cancels jobs.
- **Public visitors**: anyone on mint.chickenbone.dev. They see live library stats and the job pipeline, browse the library, play 30-second previews, and can request access.

## Product Purpose
Mint turns a person's YouTube Music likes into real files on a self-hosted server. It finds album-quality releases through Lidarr and TorBox, falls back to a self-hosted Cobalt rip from YouTube, tags the files, imports them into Plex, waits for Plex sonic analysis, and serves the result to Plexamp. The job is done when a song liked on a phone shows up in Plexamp without anyone touching it.

## Positioning
Mint is a single live pipeline from "liked" to "on my own server," and every step is visible in real time over WebSockets. The public front page shows the pipeline running.

## Operating Context
- Hosted at mint.chickenbone.dev with Docker Compose. Images are published to GHCR from GitHub Actions.
- Lidarr, TorBox (debrid), Cobalt, and Plex live on an internal network. The public app never talks to them directly; it uses Postgres, Redis queues, and a read-only preview volume.
- Members listen in Plexamp. The web app is for managing, monitoring, and previewing, not full playback.

## Capabilities and Constraints
- Access is by request only. A visitor submits a name, email, and password; the account stays inactive until an admin approves it.
- YouTube linking uses Google OAuth with the read-only YouTube Data API scope.
- There is one shared Plex music library. Each member has their own likes and playlists, which map to Plex playlists.
- Download order: MusicBrainz match, then Lidarr album search with the TorBox blackhole bridge, then a Cobalt audio fallback.
- Pipeline stages: queued, matching, searching, downloading, importing, tagging, scanning, previewing, analyzing (sonic), ready, failed.
- Previews are the first 30 seconds, made by the worker and served from a read-only volume.

## Brand Commitments
- Name: **Mint**.
- The member app must feel like Spotify: a sidebar library, a track table, and a persistent bottom player bar.

## Evidence on Hand
- There are no users, testimonials, or metrics yet. All stats on the front page must come from the live database and must never be invented.

## Product Principles
1. Show the machine. Every job's stage and progress is visible, live.
2. Keep a hard wall between the public app and the media services.
3. Fully automatic once linked. Manual actions are for exceptions only.
4. Use album quality first and fall back to YouTube, and always label which source a file came from.
