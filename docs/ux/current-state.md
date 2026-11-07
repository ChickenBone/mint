# Mint UX current state

The walkthroughs below are **historical isolated browser evidence**, not a
claim that the current Expo app or a deployed backend passed the same journey.
Current contracts live in [DESIGN.md](../../DESIGN.md),
[mobile design](../mobile-design.md) and [native playback](../mobile-playback.md).
The Expo consumer app now leads with Home/Search/Your Library and Search's
data-backed Browse all; Next.js listening and admin management remain supported.
Android APK/EAS compatibility checks do not prove physical-device background
playback, lockscreen artwork, offline recovery or OTA application.

## Historical browser verification

**Verification date:** 2026-11-04
**Environment:** disposable `mint_redesign_demo` Postgres database, isolated loopback Redis, fictional seeded catalog, and Chromium at 390×844 and 1440×1000. Sign-in used the fixture account and an ephemeral test-only password. No production service or library was accessed.

The sign-in → search → play → Library → Now Playing → create playlist → add a song → Downloads journey completed in **19 discrete interactions**:

| Task | Interactions | Observed behavior |
| --- | ---: | --- |
| Sign in | 3 | Enter email and password, submit. |
| Find and play a song | 3 | Open Search, enter a title, select Play. Search currently occupies the music browser rather than a global overlay. |
| Open Library | 2 | Select Library, then select Songs; the route initially opens Albums. |
| Open Now Playing | 1 | Select the artwork/title in the persistent player dock. |
| Create a playlist and add the song | 9 | Open Your collection, expand creation, name and create, return to Library, choose Songs, open the row menu, open playlist choices and select a playlist. |
| Reach Downloads | 1 | At desktop width, use the sidebar. The mobile navigation has no Downloads destination. |

Playback started from Search and remained on the same audio element while navigating to Library. Now Playing, playlist creation, and Downloads remained reachable afterward. The player dock consumes two rows on phone widths, in addition to the five-item bottom navigation. The Search screen shows library-category buttons, collection playback controls and filters alongside the query, so search and catalog browsing are not clearly separated. Library requires an extra tab selection to reach songs. Adding a song depends on the existing row menu and a previously created Mint playlist.

The first ad-hoc preview pass used a playback-only local gateway rather than the fixture's artwork endpoint; it produced artwork-worker 503 console messages. Those are a preview-harness limitation, not counted as a verified product failure. The completed journey itself did not report a client exception. Baseline screenshots were kept in temporary session storage and are not repository assets.

### Part 2 pre-change walkthrough (Your music, Settings, Management & Onboarding)

**Verification date:** 2026-11-05
**Environment:** disposable `mint_redesign_demo` Postgres database, local Redis (`127.0.0.1:6379`), fictional seeded catalog with active member, admin, pending access request, YouTube playlist, and failed track job; walked in Chromium at `390×844` and `1440×1000` as both **member** and **admin**.

| Task | 390px (Phone) | 1440px (Desktop) | Confirmed baseline findings |
| --- | --- | --- | --- |
| Open My playlists / likes / downloads / history | 2–3 taps via Settings hub (`Your space`) for YouTube likes, Spotify, Downloads, and History; YouTube playlists (`After hours`) are not listed on `/app/collections` at 390px (`hasUnifiedSourceList: 0`). | 1–2 taps via sidebar sub-links (`/app/collections`, `/app/liked`, `/app/spotify`, `/app/downloads`, `/app/history`, `/app/playlists/[id]`). | Personal music is split across six routes (`/app/collections`, `/app/liked`, `/app/spotify`, `/app/playlists/[id]`, `/app/downloads`, `/app/history`). `/app/collections` only has `Playlists` and `Mint likes` buttons (`hasDownloadsTabOnCollections: 0`, `hasHistoryTabOnCollections: 0`), and at `390px` synced YouTube playlists only appear inside the `<select>` copy dropdown rather than as a unified playable list. |
| Connect a service | 2 taps (Topbar avatar → Settings → `Link with Google` or `Manage Spotify account and playlists`). | 2 taps (Sidebar/Topbar Settings → `Link with Google` or `Manage Spotify account and playlists`). | YouTube Music sync controls live inline on `/app/settings`, while Spotify account/playlist management requires a separate navigation to `/app/spotify`. |
| Change a playback setting | Unreachable from `/app/settings` (`hasPlaybackSettingsOnSettings: false`). Because the bottom bar hides `Audio settings` on phone (`<768px`) and `/app/now-playing` hides the `Sound` tab when no track is active (`soundTabVisibleWithoutTrackOnPhone: false`), changing `MP3 compatibility` or EQ at `390px` requires starting playback first (4 taps). | 2 taps via the bottom player bar `Audio settings` button (still absent from `/app/settings`). | Playback & sound controls exist only inside the player popover / active Now Playing `Sound` tab, not under `/app/settings`. Meanwhile, `/app/settings` still shows a stale `"Listen"` section with an `"Open Plexamp"` (`plexamp://`) button and a 3-step Plexamp install list (`hasStalePlexampOnSettings: true`). |
| Find a device | 2 taps (Topbar avatar → Settings → `Devices & parties` → `/app/devices`). | 2 taps (Settings → `Devices & parties` → `/app/devices`). | Devices and parties live on a standalone `/app/devices` route linked from `/app/settings` rather than inside a structured Settings `Devices` section. |
| Approve a request (admin) / Role boundary (member) | Admin: 3 taps (Topbar avatar → Settings → `Admin` → `Approve`). Member: `Admin` link is hidden in Settings (`adminVisibleInSettings: false`), and visiting `/app/admin` redirects to `/app`. | Admin: 3 taps (Settings → `Admin` → `Approve`). Member: `Admin` link hidden; `/app/admin` redirects to `/app`. | `/app/admin` is protected from members, but `/app/settings` ("Your space") still exposes `Activity & requests` (`/app/jobs`) and `Workers` (`/app/workers`) to non-admin members alongside listening links, surfacing pipeline/worker management concepts outside an admin-only `/app/manage` destination. |
| Retry a failed job | 3 taps (Topbar avatar → Settings → `Activity & requests` → `/app/jobs` → `Retry`). | 3 taps (Settings → `Activity & requests` → `/app/jobs` → `Retry`). | Failed jobs (`Paper Planes`) render with a `Retry` action on `/app/jobs`, while system-wide queue/worker/analysis diagnostics are split across `/app/admin`, `/app/jobs`, `/app/workers`, and `/app/admin/analysis`. |

## Verified after rebuild

The isolated browser journey now exercises persistent Search, direct song playback, Library, Now Playing, shared row actions, playlist creation and Undo, Downloads, device navigation, legacy redirects, and the responsive shell. The same mounted audio element continued playing across Home, Discover, Library, Downloads, Now Playing and Devices. Screenshots were captured at 360, 390, 768 and 1440 pixels; an additional 320-pixel small-screen check found no horizontal overflow.

The same success path is estimated at **15 interactions** (or 16 if the optional Undo is counted), down from 19: Sign in 3; Search and play 3; open Library 1; open Now Playing 1; create and add through the track menu 5; reach Downloads through the track menu 2. Library opens on Songs, so the former extra tab selection is gone. Search now opens in place, groups live results, and restores focus on Escape.

The browser fixture's full-document teardown navigation can abort a pending listening-history `keepalive` request; the app reports that rejected write, and the fixture recognizes only that teardown cancellation while still asserting on other browser errors. A duplicate-edition chart stress case proved flaky and was excluded from the final run; chart acquisition, deduplication, and provider error/empty states remain exercised.

An optional extended screenshot pass also observed a React hydration error on `/app/admin`. Management is outside this phase and was not changed; that route was excluded from the final in-scope screenshot run.

### Part 2 post-rebuild verification (Your music, Settings, Management & Onboarding)

**Verification date:** 2026-11-05
**Environment:** disposable `mint_redesign_demo` Postgres database, local Redis (`127.0.0.1:6379`), fictional seeded catalog with active member, admin, pending access request, Mint/YouTube/Spotify playlists, and failed track job; verified in headless Chromium via Playwright across `360px`, `390px`, `768px`, `1024px`, and `1440px` viewports with zero console or page errors.

| Flow | Before (390px / 1440px) | After (390px / 1440px) | Verified behavior |
| --- | --- | --- | --- |
| Open any Your music playlist, Likes, Downloads, or History | 2–3 taps via Settings hub; YouTube playlists absent from `/app/collections` on phone | **2 taps** on phone (`Your music` in bottom nav → playlist or tab); **1–2 taps** on desktop | `/app/collection` unifies Mint, YouTube, Spotify, and smart playlists with source filter chips (`All`, `Mint`, `YouTube`, `Spotify`, `Smart`), `+ New playlist`, and `Playlists \| Likes \| Downloads \| History` tabs. Detail route `/app/collection/[id]` handles all playlist origins and keeps missing/ambiguous Spotify rows visible with reasons and without auto-downloading. |
| Add a song to a Mint playlist | 5–9 interactions depending on route | **3 taps** (`More options` → `Save to Mint playlist` → playlist name) | Verified on phone (`390px`) from `/app/library` with immediate toast confirmation and `Undo`. |
| Connect or manage a music service | Split across `/app/settings` (YouTube) and `/app/spotify` (Spotify) | **2 taps** (`Settings` → `Connected services`) | Both YouTube Music and Spotify status, last sync, connect/disconnect, and per-playlist sync controls live together in `Settings → Connected services`. |
| Change a playback setting | Unreachable from `/app/settings`; required active playback on phone (4 taps) | **2 taps** (`Settings` → `Playback and sound`) | `MP3 compatibility`, `Normalize volume`, and `Equalizer` presets are directly configurable in `Settings → Playback and sound` regardless of whether a track is playing. Stale `Open Plexamp` (`plexamp://`) guidance was replaced by a single low-key note in `Settings → Account`. |
| Find a device or listening party | Standalone `/app/devices` route | **2 taps** (`Settings` → `Devices`, with redirect from `/app/devices`) | Named devices, playback handoff, and listening parties live under `Settings → Devices`; destructive actions (removing a device, leaving/ending a party) require confirmation via `ConfirmDialog`. |
| Approve a request / retry a failed job / inspect workers & analysis | Split across `/app/admin`, `/app/jobs`, `/app/workers`, `/app/admin/analysis`; hydration mismatch on relative timestamps | **2–3 taps** for admins via `/app/manage` (`Requests`, `Jobs and queue`, `Workers`, `Analysis`) | `/app/manage` consolidates all operator views with a summary strip, responsive card stacking on phone (`<768px`), actionable error descriptions, hydration-safe relative timestamps, and `ConfirmDialog` on destructive actions (`Deny`, `Revoke`, `Remove`, `Re-run`). Non-admin members never see `Management` nav entries and are redirected to `/app` if they visit `/app/manage`. |

### Mint DSP & Audio Analysis v2 (`mint-dsp-v2`) verification

- **Management UI Offloading (`/app/manage?tab=analysis`)**: Added an **Execution & worker offloading** card with live `executionMode` selection (`remote-only`, `prefer-remote`, `hybrid`) that updates NAS scheduling within two seconds without editing `.env` or recreating containers. Added per-worker throughput telemetry (`completedCount`, `failedCount`, `avgDurationMs`, `activeTrackId`, `engineVersion`), `v2` vs legacy `v1` coverage counts, and an **Upgrade v1 tracks to v2** backfill mode that keeps `v1` measurements readable until `v2` completes.
- **Inside This Recording & Sound Panel**: `TrackAnalysis` displays `v2` detected genres/sub-styles, mood tags, vocal/instrumental badges, Camelot + Open Key notation, BPM + beat stability, danceability, EBU R128 integrated loudness, true peak, loudness range (`LRA`), crest factor, and waveform `introEndSec`/`outroStartSec` cue markers, while falling back cleanly for `v1`-analyzed tracks. `AudioPanel` exposes 8 EQ presets (`Flat`, `Warm`, `Vocal`, `Low listening`, `Bass boost`, `Acoustic`, `Electronic`, `Late night`), true-peak safe limiter (`-0.3 dBFS`), Fletcher-Munson equal-loudness contour, stereo stage (`normal`, `crossfeed`, `wide`), and album/track/auto normalization mode (`normalizeMode`).
- **Library Filters & Smart Playlists**: `/app/library` filter drawer and `/app/collection/[id]` Smart Rules support filtering by `genre`, `mood`, `minBpm`, `maxBpm`, `camelotKey`, and `vocalType`.

## Scope of these measurements

The [target plan](target-ux.md) records the browser rebuild's route and measurement
assumptions. Preserve dated results as historical evidence; re-run a scoped
journey before calling them current or extending them to native devices.
