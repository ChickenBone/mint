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

- **Public pages.** A sticky blurred `SiteHeader` above a `max-w-7xl` column with `px-5 sm:px-8`. The landing hero sits on `ArtWall`: drifting rows of real library covers behind a left-to-right scrim.
- **Dashboard.** A Spotify‑style two‑zone shell: the sidebar (nav and "Your music"), the main pane whose `PageHeader` takes a blurred real cover as its `backdrop`. Panels are `rounded-xl bg-surface` with an 8px gutter.
- **Below `lg`.** The sidebar collapses into a top bar.
- **Small screens.** No horizontal scroll at 320 px. Header actions are `whitespace-nowrap`, and secondary links hide on narrow screens.

## Components (`apps/web/src/components`)

- **TrackList / TrackCard.** These are the only ways to show tracks.
  - Rows show the number, artwork (greyed while in flight), title and artist, the stage badge, and the duration.
  - Cards are square artwork that link to the song on YouTube Music, with an arrow that appears on hover/focus. `FreshShelf` leads with one 2×2 feature card.
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
5. One authored motion moment: a song that lands while the page is open drops onto the shelf with the `land` reveal (blur to sharp, clip-path open). `drift`, `rise` and `stage-flash` support it. All stop under `prefers-reduced-motion`.
6. Icons are `lucide-react` at 16–20 px, `strokeWidth` 2. There are no brand logos.
