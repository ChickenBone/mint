# UX rebuild target: foundations, core listening, your music, settings, management and onboarding

> **Assumption note:** The originally referenced target UX document was not present in this checkout. This plan records the route and measurement assumptions used to implement Prompt 1 and Prompt 2 scope. It does not claim to reproduce unavailable wireframes, state-matrix details, or section 8 measures.

## 1. Information architecture

Primary destinations are Home (`/app`), Discover (`/app/discover`), Library (`/app/library`) and Your music (`/app/collection`). Desktop uses a full navigation rail (`lg`); tablet uses a collapsed icon rail (`md`); phone (`<md`) uses four bottom destinations and an avatar entry to Settings (`/app/settings`). Admins additionally see an admin-only Management (`/app/manage`) destination with a pending-count badge. Search is a persistent top-bar action and a desktop `/` shortcut. The player provider remains above routed content so navigation cannot recreate the audio engine.

| Area | Destination | Canonical route | Legacy redirects |
| --- | --- | --- | --- |
| Home | Home & first-run welcome | `/app` | — |
| Discover | Discover home | `/app/discover` | — |
| Discover | Mixes | `/app/discover/mixes` | `/app/discover?tab=mixes`, `/app/discover?mode=…` |
| Discover | Charts | `/app/discover/charts` | `/app/discover?tab=charts` |
| Discover | Chart detail | `/app/discover/charts/[chart]` | `/app/discover?chart=…` |
| Library | Library catalog | `/app/library` | `/app/music`, `/app/library?tab=…` |
| Library | Album detail | `/app/library/albums/[id]` | `/app/music?kind=album&id=…` |
| Library | Artist detail | `/app/library/artists/[id]` | `/app/music?kind=artist&id=…` |
| Search | Search overlay & fallback | `/app/search` | `/app/music?view=search&q=…` |
| Now Playing | Record-sleeve workspace | `/app/now-playing` | `/app/music?view=now-playing` |
| Your music | Playlists, Likes, Downloads, History | `/app/collection` (`?tab=playlists\|likes\|downloads\|history`, `?source=all\|mint\|youtube\|spotify\|smart`) | `/app/collections`, `/app/liked`, `/app/spotify`, `/app/downloads`, `/app/history` |
| Your music | Unified collection detail (Mint, Smart, YouTube, Spotify) | `/app/collection/[id]` | `/app/collections/[id]`, `/app/playlists/[id]`, `/app/spotify/[id]` |
| Settings | Account, Connected services, Playback and sound, Devices, Offline storage | `/app/settings` (`?section=account\|services\|playback\|devices\|storage`) | `/app/devices`, `/app/spotify?linked=…\|error=…` |
| Management | Admin-only Requests, Jobs and queue, Workers, Analysis | `/app/manage` (`?tab=requests\|jobs\|workers\|analysis`) | `/app/admin`, `/app/jobs`, `/app/workers`, `/app/admin/analysis` |

## 2. Core flows and verified measures

Baseline and post-rebuild counts use the same seeded tasks and count explicit clicks, key activations, and text-entry submissions (not browser navigation or waiting).

| Flow | Verified baseline | Target | Verified post-rebuild |
| --- | ---: | --- | ---: |
| Sign in → search and play → Library → Now Playing → create playlist and add song → Downloads | 19 interactions at 390px / 1440px | At most 16 interactions, without a route reload or audio-engine replacement | 15 interactions (16 with Undo) |
| Reach any Your music item (playlist, Likes, Downloads, History) on phone (`390px`) | 2–3 taps via Settings hub; synced YouTube playlists unreachable as a playable list on `/app/collections` at 390px | `<= 2` taps on phone | **2 taps** (Tap 1: `Your music` in bottom nav → `/app/collection`; Tap 2: playlist card or `Likes` / `Downloads` / `History` tab) |
| Add a song to a playlist | 5–9 interactions depending on playlist creation | `<= 3` taps | **2 taps** (Tap 1: `More options` on song row; Tap 2: `+ Playlist` in menu, with Undo toast) |
| Change a playback setting on phone (`390px`) | 4 taps (had to start a song first because Settings lacked playback controls and Now Playing hid `Sound` without an active track) | Direct in Settings (`Playback and sound`) | **2–3 taps** (`Settings` → `Playback and sound` → toggle/preset) |
| Search with keyboard | No global-search keyboard behavior in baseline | `/` opens and focuses Search on desktop; Escape closes and restores focus | Verified |
| Route continuity | Same audio element continued across Library navigation | Same mounted audio element and progressing playback across every touched route | Verified across Home, Discover, Library, Your music, Settings, Management and Now Playing |
| Responsive shell & overflow | Phone had a two-row dock and five bottom destinations; Downloads absent from phone nav | Four primary phone destinations, accessible Settings entry, compact persistent player, zero horizontal overflow at `360px` | Verified at `360`, `390`, `768`, `1024` and `1440` (`scrollWidth <= innerWidth`) |

## 3. Shared interaction and visual contract

- Preserve the Listening room charcoal levels, Figtree, mint action/focus accent, reduced-motion behavior, visible keyboard focus and 44px minimum touch targets.
- Provide skip navigation, one primary content landmark, a navigation landmark and a persistent player.
- Search results are grouped by Songs, Artists and Albums and retain recent searches. Preserve local-library matching, explicit missing-music requests and their existing authorization boundary.
- Use one shared track action menu across in-scope song rows: play next, queue, playlist (recent playlists and create), like, artist/album navigation and download. Confirm successful playlist additions with an undoable toast.
- Preserve existing queue snapshots, bounded catalog windows, full-collection shuffle, read-only originals, account isolation and private media authorization.
- Keep chart provider/territory/period/publication details and explicit acquisition in chart detail. Do not invent artwork, availability, rankings or counts.
- **Your music (`/app/collection`)**:
  - Unified playlist list across Mint native playlists, YouTube imports, Spotify metadata playlists and smart playlists, with source badges, filter chips (`All | Mint | YouTube | Spotify | Smart`), `+ New playlist` modal dialog, and sync state as icon + text.
  - Unified collection detail (`/app/collection/[id]`) with Play, Shuffle, Download, and Menu actions; missing/ambiguous Spotify songs remain visible with their match status and reason and never auto-download.
  - Native editor capabilities (duplicate scanning, custom artwork, folders, pinning, smart rules, collaboration) remain reachable inside Mint collection detail.
- **Settings (`/app/settings`)**:
  - Restructured into five sections: `Account`, `Connected services` (YouTube Music and Spotify status, last sync, connect/disconnect, what-to-sync and per-playlist sync), `Playback and sound`, `Devices` (named devices, handoff, listening parties), and `Offline storage`.
  - Uses a list-to-detail pattern on phone (`<768px`) and a two-pane layout on tablet/desktop (`>=768px`).
  - Stale Plexamp guidance is removed across the app; only a single low-key note in `Account` states that an optional external Plex client needs its own separate Plex invitation.
  - An admin-only `Management` entry appears in Settings and navigation only for admins.
- **Management (`/app/manage`)**:
  - Consolidates `Requests` (access requests and members), `Jobs and queue` (service health, pipeline queues, failed and in-progress tracks), `Workers` (built-in NAS status and volunteer workers), and `Analysis` (measured-audio coverage, remote offload and resource controls).
  - Top summary strip, tables that stack into cards on phone (`<768px`), `ConfirmDialog` for destructive actions, pending-count badge on the nav entry for admins, and actionable error text.
  - Pipeline vocabulary lives in `/app/manage`; listening surfaces use listener language (`"Bringing in your music · X of Y playable"`).
- **Onboarding & public pages**:
  - `/request-access` explains the three-step approval flow and shows a confirmation card detailing expected wait and next steps.
  - First-run welcome on `/app` guides members to connect a source, explore the library, or start listening, and transitions to live playable progress (`"X of Y playable"`) once linked.
  - Public pages (`/`, `/browse`, `/charts`, `/activity`, `/login`, `/request-access`) share the Listening room visual language, skip link, 44px targets, and clear paths to Request access or Sign in without exposing visitor playback or acquisition.

## 4. Screen-state coverage

For each in-scope route and panel, distinguish:

| State | Expected presentation |
| --- | --- |
| Loading | Skeletons with stable layout and useful accessible status. |
| Empty | Context-specific explanation and a next action (`Connect a service`, `Browse library`, `+ New playlist`). |
| Error | Explicit problem, retry/recovery where supported; never imply success. |
| Offline | Explain which data/actions remain available and link directly to offline Downloads (`/app/collection?tab=downloads`). |
| Unavailable | Explain capability or provider unavailability distinctly from empty data (including missing/ambiguous Spotify rows). |

Loading, empty, error, offline and unavailable states must not rely on color alone.
