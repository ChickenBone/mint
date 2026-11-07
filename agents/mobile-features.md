# Focused mobile features

The Expo listener app is the consumer UX/UI design authority. Browser consumer
UX is frozen, maintenance-only; existing routes/listening, security fixes,
backend/API compatibility and Next.js administration remain supported.
Route ordinary feature
requests without asking people to name a domain. An explicit browser, backend or
file-path request takes precedence; inspect the current owner and contract before
editing. These are capability names, not a replacement for album/artist/playlist
entity schemas.

## Active seams

| Capability | Owner / feature folder | Route |
| --- | --- | --- |
| Home | `mobile-home` / `src/features/home` | `/` |
| Artists | `mobile-artists` / `src/features/artists` | `/artist/[id]` |
| Albums | `mobile-albums` / `src/features/albums` | `/album/[id]` |
| Playlists and liked-song details | `mobile-playlists` / `src/features/playlists` | `/collection/[id]` |
| Discover/Search and Browse all | `mobile-search` / `src/features/search` | `/search`, `/browse/[facet]` |
| Your Music (UI label: Your Library) | `mobile-your-music` / `src/features/your-music` | `/library` |
| Settings | `mobile-settings` / `src/features/settings` | `/settings` |
| Player presentation | `mobile-player` / `src/features/player` | `/player` and persistent sheet |

Paths in this table are relative to `apps/mobile`. Route files are thin feature
adapters. Feature cards own their exact route and focused tests. The manifest and
`owner` command, not this explanatory table, determine file ownership.

## Shared contracts, not shared feature internals

- `mobile` owns Expo configuration, `src/shell`, auth/API wiring, theme, shared
  `src/components/{ui,music}` and app-wide hooks. Reuse shared primitives and
  `screen-styles`; do not import Home exports into other features. Shared
  `CollectionDetail` presents entity-specific adapters without conflating album,
  artist and playlist identity or mutation rules.
- `mobile-contracts` owns `@mint/client` DTOs/validation/HTTP and the allowlisted
  `/api/native/**` server facade. UI changes consume these contracts; backend
  changes require the owning card, not every UI session loading server guides.
  Never import `@mint/core`, database/Redis, worker credentials or Next.js into
  native runtime. Audio uses the authenticated public Mint proxy; artwork uses
  its separate public proxy, never credential-bearing image URLs.
- `mobile-playback` owns `PlayerProvider`, native adapters, queue/lyrics models
  and account-scoped offline stores. Keep one provider mounted outside routes;
  `/player` opens its existing presentation, never another engine. Restore
  paused and preserve duplicate occurrence IDs, current-item continuity and
  account/server isolation.
- Play/Shuffle targets complete server-owned selections, not visible windows.
  Render and fetch bounded pages. Account/server or query changes cancel stale
  work; retain loading/empty/error/retry states and independent source failures.
- Browsing, charts and Play never acquire missing music. Only explicit supported
  requests do. Source-managed imports stay read-only and copying stays separate.
  Native DSP/Smart Fades and device behavior are not implied by browser support.
- Server-side public metadata caches are feature contracts, not an excuse to
  share member responses or cache authorization. Local developer diagnostics
  consume real engine/existing analysis observations, remain opt-in and bounded,
  and never upload traces.

## UI and verification

For native UI tasks, first read the repo-local
[Mint mobile UX skill](../.github/skills/mint-mobile-ux/SKILL.md), then only its
task-relevant references. No app-installed plugin is required; do not eagerly
load all official Expo documents. The [mobile-design card](domains/mobile-design.md)
owns skills/provenance, not feature runtime code.

Use shared tokens, readable contrast, labeled controls, 44px targets, safe-area
insets, bounded lists and reduced-motion behavior. Phones retain Home, Search and
Your Library tabs; wide screens retain the sidebar and persistent player.
Preserve existing listener functions and backend/admin capabilities.

Begin with the listener's task: one primary action per area, with preserved
secondary actions in accessible overflow. Swipes keep web action meaning but
have explicit button/menu equivalents; do not intercept scrolling or seeking.
Provide immediate tap feedback and distinct pending/success/error/retry states.
Use independently implemented Spotify-inspired gestures and artwork-derived
dynamic gradients with readable neutral fallbacks, not proprietary assets or
parity claims. Native animation communicates state or direct manipulation, not decoration;
respect reduced motion, interruption and cancellation. Keep one player engine.
Use current tokens/components/dependencies; Tailwind/NativeWind is not adopted.

Read the chosen card and its focused test selector. `npm run agents -- affected`
adds actual consumer checks for shared contracts. Source/type/fixture tests do
not prove native compilation, suspended playback, lockscreen controls or physical
device delivery. Broader operational details live in
[mobile setup](../docs/mobile.md), [visual contract](../docs/mobile-design.md) and
[native playback](../docs/mobile-playback.md); load them when the task needs them.
High-FPS/smoothness claims require repeatable release-build physical-device
measurements, including device, refresh rate, scenario and profiling evidence;
an export or animation dependency is not a frame-rate result. Keep evidence
private and report unavailable tooling. Mint-specific restrictions override
generic Expo Go/audio, library/theme mandates and telemetry/reporting advice.

## Future extension seams — not active features

| Future area | Present reality / contract to inspect | Activation boundary |
| --- | --- | --- |
| Events | No listener event-browsing feature. Existing `realtime` domain's `packages/core/src/events.ts` is transport/invalidation, not a concert/social Events product. | Agree real event data, permissions and APIs before creating `src/features/events`. |
| Profiles | Existing auth account/avatar data is not public member profiles. Artist metadata profiles remain Artists/library entities. | Define visibility and account ownership before creating `src/features/profiles`; coordinate native contracts and account owners. |
| Jams / Devices | [Devices domain](domains/devices.md) and [device contract](../docs/devices.md) already implement browser registry, handoff, remote control and single-output parties. No native Jams screen or synchronized multi-output guarantee. | Confirm native allowlisted transport and acknowledged handoff, then create `src/features/jams` or `devices` for actual supported UI. |

Do not add empty feature folders, navigation placeholders, fabricated content or
unused active domain patterns. To activate a seam: obtain current authorization,
define contracts in their owner, implement real files/routes/tests, add the
focused domain/card and keywords, then sync and run strict map/routing checks.
Keep existing domains within the unchanged budgets rather than hiding files or
raising limits. For task-private evidence, explicitly opt into
[ignored local memory](local-memory.md); memory is not a product specification.
