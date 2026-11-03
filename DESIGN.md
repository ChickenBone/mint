# Mint design system

Mint is dark, quiet and record‑shop warm. The music, meaning the artwork and titles, carries the colour. Chrome stays neutral, and mint green is reserved for *live* and *act*. See PRODUCT.md for voice and audience.

## Tokens (`apps/web/src/app/globals.css`)

| Token | Value | Use |
| --- | --- | --- |
| `bg` | `#0a0d0c` | Page background |
| `surface` | `#121614` | Panels: sidebar, main pane, cards |
| `elevated` | `#1a1f1d` | Raised cards inside panels, inputs |
| `hover` | `#232a27` | Row and button hover, scrollbar |
| `line` | `#2a322f` | Hairlines, rings, and dividers. Use `/60` for subtle ones |
| `fg` | `#f2f5f3` | Primary text |
| `muted` | `#a3ada8` | Secondary text, nav |
| `faint` | `#7d8883` | Metadata, timestamps. Still ≥4.5:1 on `bg` |
| `mint` / `mint-strong` | `#3fe0a0` / `#5cf0b4` | Primary actions, live state, progress, focus ring |
| `mint-ink` | `#04140d` | Text on mint |
| `danger` / `warn` | `#ff7a6b` / `#f5c86b` | Failed jobs, destructive actions / waiting and reconnecting |

- **Easing.** `ease-out-expo` for entrances. Motion is short: 150–300 ms for UI and a single 1.2 s `stage-flash` when a track changes stage. Everything respects `prefers-reduced-motion`.
- **Numbers.** Use `tabular` for counters, durations and progress.

## Type

The typeface is **Figtree** (variable, via `next/font`), and nothing else.

| Role | Size and weight |
| --- | --- |
| Display (hero, page titles) | hero `clamp(2.75rem,9vw,7.5rem)` at `leading-[0.92]`; titles `text-4xl`–`text-7xl`, `font-extrabold`, `tracking-[-0.035em]` |
| Section headings | public `text-4xl sm:text-6xl font-extrabold`; app `text-3xl font-extrabold` |
| Rows and cards | `text-sm`/`text-base font-semibold` for titles, `text-sm text-muted` for artists |

Headings use `text-wrap: balance` and paragraphs use `pretty`.

## Layout

- **Public pages.** A sticky blurred `SiteHeader` above a `max-w-7xl` column with `px-5 sm:px-8`. The landing hero sits on `ArtWall`: four drifting rows of real, distinct covers selected across the entire landed library, not just its newest songs. Even one available cover can form the backdrop; an empty library gets no invented art. Identical padded row groups make the loop seamless, artwork failures use the shared neutral fallback, and left-to-right/bottom scrims keep copy readable.
- **Dashboard.** A Spotify‑style persistent shell: sidebar (nav and "Your music"), main pane and a bottom Mint player bar, separated by an 8px gutter. Music browsing uses the embedded Plexamp engine with Mint's tokens and Figtree; management pages keep their artwork-led `PageHeader`. Moving between them never remounts the engine.
- **Below `lg`.** The sidebar becomes a compact top bar with Music, Library and a keyboard-accessible More menu. The docked player keeps cover/title, play/pause, next, seek, lyrics, audio settings and queue visible. Opening Now playing replaces the dock with pinned full transport, shuffle and repeat; listening tools scroll above it. Safe-area insets protect installed-phone controls.
- **Small screens.** No horizontal scroll at 320 px. Header actions are `whitespace-nowrap`, and secondary links hide on narrow screens.

## Components (`apps/web/src/components`)

- **TrackList / TrackCard.** These are the only ways to show tracks.
  - Rows show the number, artwork (greyed while in flight), title and artist, the stage badge, and the duration.
  - Approved member rows and cards play downloaded tracks in Mint. Options buttons, right-click and keyboard menus expose Mint-owned queue and album/artist actions. Public cards still link to YouTube Music; public rows have no audio controls. `FreshShelf` leads with one 2×2 feature card.
- **Player.** One persistent engine per member tab. Mint owns transport, queue, context menus and Now playing; the embedded engine stays mounted for browsing and actual media playback. Clicking dock artwork/title opens a record-sleeve view with large cover, title, artist and album, and no duplicate player chrome. Desktop pairs the sleeve with listening tools; smaller screens put tools beneath it and pin transport outside the scrolling region. Back/Escape returns to the originating page without remounting audio. Native player routes redirect to the same Mint view. A single 260 ms clipped reveal marks opening; reduced motion removes it.
- **Collections and panels.** Library, search results, likes and playlists expose explicit Play and Shuffle actions, with loading/empty states. Docked playback has one complementary Queue, Lyrics or Audio settings panel at a time. Now playing integrates them as Up next, Lyrics and Sound tabs with arrow/Home/End navigation; visited tabs preserve drafts and fetched lyrics. Upcoming tracks exclude playback history, and clearing upcoming never stops the current song. Lyrics follow playback unless the listener scrolls. Browser-only EQ, compression and crossfade edits apply together, confirm only after acknowledgement, and show explicit failures while retaining drafts. Sound processing and LRCLIB lyrics do not depend on Plex Pass. Unsupported processing controls and unconditional Plex-dependent sonic actions are hidden rather than advertised; track menus offer Shuffle this artist instead.
- **StageBadge + ProgressBar.** Each pipeline stage has one colour and one label everywhere: queued, matching, downloading, importing, sonic scan, ready, failed. Failed rows show the error detail and a retry.
- **PipelineBoard.** Live lanes for each stage, fed by `useLiveTracks`.
- **LiveStats.** The library as one live sentence (numbers in `fg`, words in `faint`), plus the source and sonic ratio bars. Never a grid of big numbers.
- **CoverMosaic.** Four real covers tiled as a playlist cover; falls back to an icon tile.
- **LiveDot.** Shows the WebSocket state (Live, Connecting, Offline). Show it once per page.
- **Form (`Field`, `SubmitButton`).** Labels sit above inputs, errors sit inline under the field, and submitting shows a pending state. Server actions echo values back, so fields survive errors. Passwords are never echoed.
- **Buttons.** Fully rounded.
  - Primary is `bg-mint text-mint-ink`.
  - Secondary is `ring-1 ring-line`.
  - Tertiary is text only (`text-muted hover:text-fg`).
  - Destructive actions use `danger` and confirm first.

## Rules

1. Mint green means *live* or *act*. Never use it for decoration.
2. Artwork falls back to a neutral music‑note tile, never a gradient placeholder.
3. Empty states say what will happen next ("Link YouTube Music to start"). Never just "No data".
4. Every live region has a non‑live fallback. Server‑rendered data comes first, and the WebSocket only adds to it.
5. One authored motion moment: a song that lands while the page is open drops onto the shelf with the `land` reveal (blur to sharp, clip-path open). `drift`, `rise`, `stage-flash` and the player's `player-reveal` (260 ms Now playing, 200 ms panels) support it. All stop under `prefers-reduced-motion`.
6. Icons are `lucide-react` at 16–20 px, `strokeWidth` 2. There are no brand logos.
