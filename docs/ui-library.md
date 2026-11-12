# Mint UI library

The web UI uses a single **Listening room** design language: cool charcoal background/surface/elevated/hover layers, Figtree, square artwork, and mint reserved for primary action and focus. A restrained teal/blue header wash and artwork-derived atmosphere enrich music surfaces; settings and administration remain quieter. This library is built on Tailwind 4, CSS variables and native HTML; it adds no UI dependency.

This is the **Next.js/browser** component contract. The primary Expo consumer
app has platform-native primitives and semantic tokens in
`apps/mobile/src/components/ui` and `apps/mobile/src/theme/tokens.ts`, with
platform typography. See [mobile design](mobile-design.md); do not import these
HTML/Tailwind components into the native runtime or assume feature parity.

## Tokens

Tokens are defined in `apps/web/src/app/globals.css`. Prefer semantic Tailwind names in components (`bg-surface`, `text-muted`, `bg-action`, `ring-danger`) over raw colors.

| Role | Tokens |
| --- | --- |
| Surfaces | `background` (`bg` compatibility alias), `surface`, `elevated`, `hover` |
| Content and state | `text` (`fg` compatibility alias), `muted`, `faint`, `action` (`mint` compatibility alias), `success`, `danger`, `warn`, `line` |
| Complementary color | `info` (soft blue), `accent` (lavender); use sparingly, never in place of semantic error/warning colors |
| Gradients | `--gradient-action` for primary actions, `--gradient-atmosphere` for music headers, `--gradient-liked` for the favorites sleeve; no gradient text |
| Type | Figtree only; title 32/48/64px, section 24/32px, body 14/16px |
| Spacing | 4px base Tailwind spacing scale; 20px phone and up to 48px wide page gutters; 40–48px section rhythm |
| Composition | `--space-panel` for 16–24px panel padding, `--space-control-gap` for related controls, `--content-max` for bounded wide listening content |
| Shape and depth | `radius-control`, `radius-surface`, `radius-pill`, `shadow-raised`, `shadow-floating`; sleeves remain square |
| Motion | `duration-fast`, `duration-standard`, `duration-emphasis`, `ease-standard`, `ease-out-expo`; reduced motion disables nonessential animation |
| Layers | `--z-sticky`, `--z-player`, `--z-navigation`, `--z-overlay`, `--z-toast` |
| Breakpoints | `small` 640px, `tablet` 768px, `desktop` 1024px, `wide` 1440px, alongside Tailwind defaults |
| Safe area | `--safe-area-top/right/bottom/left` from the platform insets |

The old short token names remain aliases while components migrate. Do not define a competing palette or replace these tokens with literals in component styles.

## Components

Import from `@/components/ui` or a direct module when preserving a server/client boundary matters.

| Component | Purpose and API | Do | Avoid |
| --- | --- | --- | --- |
| `Button` | Action button; `variant` primary/secondary/quiet/danger, `size` sm/md/lg, `loading` | Name the action; use mint only for the primary action | Using color as the only state cue |
| `IconButton` | Compact button requiring `aria-label`; inherits Button variants | Keep its 44px target | Unnamed icon-only controls |
| `Link` | Next.js navigation link with action variants | Use for navigation and stable destinations | Using a button for navigation |
| `Input` | Named text input with optional hint/error | Provide visible label and recovery text | Placeholder-only labels |
| `Select` | Named native select with visible label | Keep native keyboard behavior | Custom select without equivalent keyboard support |
| `Checkbox` / `Switch` | Native checkbox or labeled controlled `role="switch"` | Pair state with explicit text | State shown only by color |
| `Tabs` | Controlled tab set with Left/Right/Up/Down and Home/End navigation | Give the set a concise label | Hiding tab state from assistive technology |
| `Dialog` / `Sheet` | Native modal dialog; `variant="sheet"` docks to the phone bottom and becomes a dialog on larger screens | Supply a specific title and close action; native dialog traps focus and restores it | Interrupting a task that does not need protected focus |
| `ConfirmDialog` | Modal confirmation dialog built on `Dialog` for destructive or high-impact actions | Explain the consequence and provide explicit confirm/cancel labels | Using browser `window.confirm` |
| `Menu` | Button-triggered action menu with arrow/Home/End/Escape keys and focus return | Use for a short set of related actions | Hover-only menus |
| `Popover` | Native disclosure-style content panel | Keep its trigger and content keyboard reachable | Treating a disclosure as a modal |
| `Tooltip` | Descriptive tooltip associated with its single focusable child | Keep the label supplementary | Putting required instructions only in a tooltip |
| `ToastProvider`, `useToast` | Optional app-level transient status/error notifications | Keep important errors persistent in the page too | Using a toast as the only error record |
| `Badge` | Neutral, positive, warning or danger status label | Include meaningful text | A color-only badge |
| `Card` | Neutral content grouping; supports div/article/section | Use sparingly as a real grouping | Nested cards as page scaffolding |
| `Sleeve` | Square clipped composition for album/collection artwork | Use actual album art or a real virtual collection cover | Rounded-square sleeves or invented artwork |
| `Artwork` | Shared square art with a neutral music-tile fallback | Use only real library art or a real virtual-playlist sleeve | Invented album covers |
| `ArtworkAtmosphere` | Optional `src` in a `music-atmosphere` parent; clipped decorative image blur and dark scrim | Reuse the existing authorized artwork URL/cache; keep text above the scrim | Pixel sampling, third-party color services, full-screen blur or transparent form/menu surfaces |
| `Skeleton` | Loading placeholder | Match final geometry to prevent layout shift | Using a skeleton for a failed request |
| `EmptyState` / `ErrorState` | Distinct empty and failed states, with optional recovery action | Say what happened and what to do next | Making a failure resemble an empty success |
| `ProgressBar` / `Slider` | Labeled progress or native range control | Expose numeric range/value and keyboard control | Replacing a range input with a pointer-only slider |
| `Row` | Compact ranked/list row with optional rank and textual status | Preserve rank, availability and state in text | Hiding meaning in color |
| `Page` / `Section` | Width-safe content wrapper and 40–48px section rhythm | Keep the route's existing landmark ownership | Nesting main landmarks |
| `Shelf` | Touch-scrollable horizontal list with focus and arrow/Home/End keyboard scrolling | Label the region and provide useful headings outside the rail | Letting the page itself overflow horizontally |
| `Grid` / `Stack` / `Cluster` | Responsive layout composition with named spacing steps | Prefer composition to component prop proliferation | One-off spacing constants |

## Responsive and accessibility rules

- Start at phone widths. Use 20px page gutters on phones and scale toward 48px on wide displays. Keep 360, 390, 768, 1024 and 1440px layouts usable, plus landscape phones.
- Any intentional horizontal scrolling belongs inside a named shelf. The document must not overflow horizontally.
- Interactive targets are at least 44px. Every control has a visible focus ring, an accessible name and a non-color state cue.
- Keep headings and landmarks hierarchical; use native input, button, link, dialog and range semantics where possible.
- `Tabs` implements arrow and Home/End navigation. `Menu` implements arrow and Home/End navigation, Escape dismissal, and focus return. Native dialog provides modal focus behavior.
- Body and secondary text must meet WCAG AA contrast. Keep Figtree as the only family.
- Respect safe-area insets for persistent mobile navigation and transport. Reduced-motion mode removes nonessential animation and transitions.
- Failed artwork uses the shared neutral music tile. Loading uses final-size skeletons. Neither state fabricates availability or metadata.
- Artwork atmosphere has no interaction or accessible content. It uses the existing no-referrer image policy, is bounded to header height, and falls back to a neutral dark field on failure. An opaque dark scrim protects text contrast even on white covers. Menus, controls and queue/lyrics panels remain readable opaque surfaces.

## Component and route inventory

This is the migration baseline. Styling notes describe the current implementation; target names refer to the library above. Most current components use Tailwind utility classes in JSX. `globals.css` contains additional custom selectors for discovery shelves/covers, chart rows, the listening layout and selected player/transition states.

### Shared components (`apps/web/src/components`)

| Component | Purpose | Current styling / duplication | Target |
| --- | --- | --- | --- |
| `art-wall.tsx` | Artwork backdrop for the landing experience | Utility classes plus custom motion selectors | `Artwork`, `Grid`, motion tokens |
| `artwork.tsx` | Library artwork and unavailable fallback | Hand-built image/fallback classes, already shared | `Artwork` (source implementation) |
| `form.tsx` | Labeled form field and pending submit button | Former bespoke input/button styling; now composes `Input` and `Button` | `Input`, `Button` |
| `fresh-shelf.tsx` | Recently added music shelf | Utility classes and repeated artwork card layout | `Shelf`, `Artwork`, `Section` |
| `install-app.tsx` | PWA installation prompt/provider | Utility-styled prompt with local interaction | `Button`, `Dialog` where interruption is needed |
| `library-browser.tsx` | Library browsing/filtering surface | Utility classes and bespoke controls | `Input`, `Select`, `Tabs`, `Grid`, `EmptyState`, `ErrorState` |
| `live-dot.tsx` | Small realtime connection indicator | Inline utility styling | `Badge` or status text |
| `live-stats.tsx` | Live summary metrics | Utility-based metric blocks | `Grid`, `Section`, `Skeleton` |
| `logo.tsx` | Brand mark and wordmark | Brand-specific SVG and layout classes | Keep bespoke mark; use layout tokens |
| `pipeline-board.tsx` | Job-stage board | Utility classes and repeated status presentation | `Badge`, `Grid`, `EmptyState`, `ErrorState` |
| `realtime.tsx` | Realtime provider/context | Non-visual infrastructure | No visual primitive |
| `site-header.tsx` | Public navigation header | Utility-based responsive navigation | `Link`, `IconButton`, layout tokens |
| `stage-badge.tsx` | Track/job stage label and progress | Former hand-mapped color and progress classes; now composes `Badge` and `ProgressBar` | `Badge`, `ProgressBar` |
| `track-list.tsx` | Shared track list and playback actions | Utility classes and row patterns | `Row`, `Artwork`, `IconButton`, `Skeleton` |

### Member application components (`apps/web/src/components/app`)

| Component | Purpose | Current styling / duplication | Target |
| --- | --- | --- | --- |
| `admin-controls.tsx` | Administrative actions and controls | Utility-styled actions/forms | `Button`, `Select`, `Checkbox`, `ErrorState` |
| `analysis-panel.tsx` | Audio-analysis settings/results | Utility controls and status blocks | `Section`, `Select`, `ProgressBar`, `Badge` |
| `chart-browser.tsx` | Ranked chart and availability rows | Tailwind plus `.chart-row` global rules | `Row`, `Artwork`, `Badge`, `Button` |
| `collection-actions.tsx` | Collection-level play/edit actions | Repeated utility buttons | `Button`, `IconButton`, `Menu` |
| `copy-button.tsx` | Copy-to-clipboard action | One-off utility button | `IconButton` or `Button` |
| `devices-panel.tsx` | Device controls and handoff | Utility forms and action groups | `Section`, `Input`, `Button`, `Badge`, `ErrorState` |
| `discovery-shelves.tsx` | Mix/chart collection shelves and generated covers | Bespoke `.discovery-*` CSS, local palette and action styling | `Shelf`, `Section`, `Button`, `Artwork`; retain truthful virtual-sleeve art |
| `downloads.tsx` | Offline downloads and storage controls | Utility forms, status and progress displays | `Row`, `ProgressBar`, `Button`, `EmptyState`, `ErrorState` |
| `link-youtube.tsx` | YouTube account linking | Utility button/state classes | `Button`, `Badge`, `ErrorState` |
| `listening-history.tsx` | Private listening history | Utility list rows and controls | `Row`, `Section`, `EmptyState`, `Button` |
| `listening-spotlight.tsx` | Home listening invitation | Custom `.listening-spotlight` plus utilities | `Page`, `Section`, `Artwork`, `Button` |
| `live-track-list.tsx` | Realtime track list | Utility rows and state styling | `Row`, `Badge`, `Artwork`, `Skeleton` |
| `lyrics-match.tsx` | Lyrics match correction | Utility form and result states | `Input`, `Select`, `Button`, `ErrorState` |
| `missing-music.tsx` | Missing-recording requests | Utility rows and request controls | `Row`, `Badge`, `Button`, `ErrorState` |
| `music-browser.tsx` | Member music browsing | Utility filters and repeated row/card styles | `Input`, `Select`, `Tabs`, `Grid`, `Row` |
| `music-discovery.tsx` | Mix/radio discovery controls | Utility forms and result states | `Input`, `Select`, `Button`, `EmptyState` |
| `music-track-list.tsx` | Music track lists and playback controls | Utility row/action styling | `Row`, `Artwork`, `IconButton` |
| `native-collection-editor.tsx` | Native playlist editing | Utility form and action layout | `Input`, `Button`, `Dialog`, `ErrorState` |
| `native-collections.tsx` | Native collection index | Utility cards and action buttons | `Grid`, `Card`, `Artwork`, `EmptyState` |
| `native-likes.tsx` | Mint likes collection | Utility list rows and artwork | `Row`, `Artwork`, `EmptyState` |
| `your-music.tsx` | Playlists, likes, request backlog, downloads and history tabs | Shared tabs, state filters, list rows, collection controls and dialogs | `Tabs`, `Row`, `Button`, `EmptyState` |
| `now-playing.tsx` | Mint-owned Now Playing workspace | Utility layout plus `.now-playing*` global rules | `Page`, `Tabs`, `Artwork`, `IconButton`; keep player engine mounted |
| `page-header.tsx` | Shared route heading and cover mosaic | Utility typography/layout, custom mosaic artwork selection | `Section`, `Artwork`, `Grid` |
| `player-controls.tsx` | Playback transport and seek controls | Utility controls and bespoke range styling | `Button`, `IconButton`, `Slider`, `ProgressBar` |
| `player-panels.tsx` | Queue/lyrics/sound panels | Utility panels and selected tab patterns | `Tabs`, `Row`, `Input`, `Slider` |
| `player.tsx` | Persistent player provider, stage and transport | Stateful utility layout and player-specific CSS | Keep provider/surface ownership; use `Button`, `IconButton`, `Tabs` without remounting engine |
| `playlist-toggle.tsx` | Add/remove playlist action | Repeated utility button variants | `Button`, `Checkbox` |
| `recommendation-shelf.tsx` | Recommended music rail | Utility shelf/card styles | `Shelf`, `Section`, `Artwork` |
| `retry-button.tsx` | Retry failed operation | Utility button and pending state | `Button` |
| `sidebar-nav.tsx` | Desktop rail and mobile navigation | Utility layout, duplicated link treatment; mobile now includes Your collection alongside Home/Discover/Library and retains You for Settings | `Link`, `IconButton`, `Badge`; preserve all destinations |
| `sign-out.tsx` | Sign-out action | Utility button/link | `Button` or `Link` |
| `spotify-controls.tsx` | Spotify metadata playlist controls | Utility forms and action states | `Button`, `Badge`, `ErrorState` |
| `sync-panel.tsx` | YouTube synchronization controls/status | Utility forms and progress states | `Section`, `Button`, `Switch`, `ProgressBar`, `ErrorState` |
| `track-analysis.tsx` | Per-track analysis details | Utility measurement/status blocks | `Row`, `Badge`, `ProgressBar` |
| `track-music-actions.tsx` | Per-track collection/playback actions | Utility action groups | `Button`, `IconButton`, `Menu` |
| `workers-panel.tsx` | Worker enrollment and administration | Utility forms, status and action groups | `Input`, `Button`, `Badge`, `Dialog`, `ErrorState` |

### UI pages (`apps/web/src/app`)

All existing page routes remain in place. Pages currently compose server-rendered route data with Tailwind-heavy markup and interactive leaves; keep those server/client boundaries unless a specific primitive requires client state.

| Route | Purpose | Current styling / duplication | Target |
| --- | --- | --- | --- |
| `/` | Public landing page | Utility-based hero and public header | `Page`, `Section`, `Button`, `Artwork` |
| `/browse` | Public library browsing | Utility layout and artwork rows | `Grid`, `Row`, `Artwork`, `Input`, `EmptyState` |
| `/charts` | Public chart discovery | Utility collections and chart rows | `Shelf`, `Section`, `Row`, `Badge` |
| `/activity` | Public library activity | Utility lists and stage labels | `Row`, `Badge`, `EmptyState` |
| `/login` | Member login form | Shared form wrappers and utility layout | `Input`, `Button`, `ErrorState` |
| `/request-access` | Account request form | Shared form wrappers and utility layout | `Input`, `Button`, `ErrorState` |
| `/app` | Member home and recommendations | Utility sections and shelves | `Page`, `Section`, `Shelf`, `Artwork`, `Skeleton` |
| `/app/discover` | Mixes, radios and charts | Global shelf CSS plus utility cards | `Section`, `Shelf`, `Card`, `Button` |
| `/app/library` | Library route/entry | Utility route composition | `Page`, `Tabs`, `Grid`, `Row` |
| `/app/music` | Music search and browsing | Utility filters, tabs and results | `Input`, `Select`, `Tabs`, `Row`, `Grid` |
| `/app/collections` | Native collection index | Utility collection cards | `Grid`, `Card`, `Artwork`, `EmptyState` |
| `/app/collections/[id]` | Collection detail | Utility heading, artwork and tracks | `Section`, `Row`, `Artwork`, `Button` |
| `/app/playlists/[id]` | Imported playlist detail | Utility heading and track rows | `Section`, `Row`, `Artwork`, `Badge` |
| `/app/liked` | YouTube likes and sync | Utility controls and list | `Section`, `Row`, `Switch`, `Button` |
| `/app/spotify` | Spotify playlist index/linking | Utility forms and collections | `Grid`, `Card`, `Input`, `Button` |
| `/app/spotify/[id]` | Spotify playlist detail | Utility metadata and matched tracks | `Section`, `Row`, `Badge`, `Button` |
| `/app/downloads` | Offline download management | Utility status/progress rows | `Row`, `ProgressBar`, `Button`, `EmptyState` |
| `/app/history` | Private listening history | Utility list and controls | `Row`, `Section`, `Button`, `EmptyState` |
| `/app/jobs` | Acquisition activity and retries | Utility status rows | `Row`, `Badge`, `Button`, `ErrorState` |
| `/app/devices` | Devices and parties | Utility forms and device cards | `Section`, `Card`, `Input`, `Button`, `Badge` |
| `/app/settings` | Settings doorway | Utility setting groups | `Section`, `Link`, `Card` |
| `/app/admin` | Admin overview | Utility operational panels | `Grid`, `Section`, `Badge`, `Button` |
| `/app/admin/analysis` | Audio-analysis management | Utility controls and progress | `Section`, `Select`, `ProgressBar`, `ErrorState` |
| `/app/workers` | Worker management | Utility forms and status | `Section`, `Input`, `Button`, `Badge` |

`/app/layout.tsx` owns member navigation, the persistent `PlayerProvider`, stage and transport. `/app/layout.tsx` and `(public)/layout.tsx` are layouts, not additional page routes. Global `error.tsx` and `not-found.tsx` are failure/not-found surfaces.

In the admin portal's **Activity** tab, **Remove** removes one failed acquisition/import attempt and **Clear all failed jobs** covers all currently failed attempts, including those outside the 100-row view. Both require confirmation and server-side admin authorization. Only matching, still-failed acquisition/finalization worker records are deleted; active/waiting jobs, sync/analysis queues, parent/child flows, songs, files and provider-managed playlists remain unchanged. Successful removals are recorded against the exact failure in the existing track timeline, and a later failure appears again. Partial failures stay visible with an error so cleanup can be retried. **Retry failed** skips removed attempts and processes at most 500.

The route handlers under `/api` are non-visual contracts, not redesign targets: agent claim/heartbeat/job failure/progress; app icon, artwork, charts/request; devices and parties; health; library and music/search; Google and Spotify OAuth; player analysis/audio/catalog/info/items/lyrics/offline/queue/session; and realtime ticket endpoints. `/listen`, `/worker.yml` and `/manifest.webmanifest` are also route/metadata handlers, not page surfaces. Preserve their authorization and response contracts while migrating callers.

## Migration order and status

1. **Tokens and primitive library** — implemented in `globals.css` and `components/ui/` (including `ConfirmDialog`).
2. **Forms and app shell** — form field/submit wrappers compose the shared primitives; `ToastProvider` is mounted inside the member player shell; navigation exposes Home, Search and Your Library (`/app/collection`) with account Settings access and an admin pending badge.
3. **Player and Now Playing** — `NowPlaying` workspace at `/app/now-playing` with Queue, Lyrics and Sound tabs; `PlayerProvider` placement above routed content is preserved.
4. **Shared data components** — stage labels/progress compose `Badge`/`ProgressBar`; track rows share `TrackMenuButton` with 2-tap playlist addition and Undo toast.
5. **Feature pages (Part 1 & Part 2 completed)** — Home (`/app` with `SetupNudge` first-run welcome and playable progress), Search (`/app/search` for query results, discovery shelves and the full chart catalog; `/app/discover/charts` redirects here), mix details (`/app/discover/mixes`), Library (`/app/library`, albums, artists), Your music (`/app/collection` and `/app/collection/[id]` unifying Mint, Smart, YouTube and Spotify playlists plus Likes, request-state backlog, Downloads and History), Settings (`/app/settings` list-to-detail on phone and two-pane on desktop across Account, Connected services, Playback and sound, Devices and Offline storage), Management (`/app/manage` consolidating Requests, Jobs and queue, Workers and Analysis for admins), and Public pages (`/`, `/browse`, `/charts`, `/activity`, `/login`, `/request-access`) are all migrated with legacy redirects in place.

This inventory records the planned targets; a listed target is not a claim that the component has already migrated. Update the status and route/component rows as each shippable slice lands.

## Contribution checklist

- Reuse a semantic token and an existing primitive before adding a new class or component variant.
- Keep server components server-rendered; place state and event handlers in the smallest client leaf.
- Preserve route names, capabilities, authorization, read-only originals, progressive loading and player-engine ownership.
- Give every control a name, visible focus, a 44px target and keyboard support. Include textual state and error recovery.
- Check empty/loading/error/disabled/long-content states, reduced motion and intended narrow/desktop layouts.
- Run the focused typecheck/lint/tests and the applicable isolated browser fixture. Do not claim browser or playback verification unless it was run.
