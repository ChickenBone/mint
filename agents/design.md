# Design and experience guidance

The current visual contract is [DESIGN.md](../DESIGN.md): native mobile is the
consumer UX/UI authority, using independently implemented Spotify-inspired
interactions and artwork-derived dynamic gradients with neutral fallbacks.
Browser consumer UX is frozen, maintenance-only; preserve its existing
routes/features, security, Next.js backend/API compatibility and administration.
Browser guidance below is a retained-system reference, not a parallel redesign.

For native UI tasks, read the compact repo-local
[Mint mobile UX skill](../.github/skills/mint-mobile-ux/SKILL.md) first, then only
task-relevant references. It preserves task-first action hierarchy, accessible
gesture equivalents, immediate feedback and Mint's existing tokens/player;
generic Expo advice does not override runtime or privacy constraints. Native
release-device profiling, not a successful export, substantiates FPS claims.

## Identity and hierarchy

- Preserve the dark charcoal/Figtree/mint-green identity. Artwork and music supply the color; mint marks actions and focus.
- Use readable secondary text, familiar controls and clear section separation.
- Prefer coherent collection shelves and artwork-led views over crowded diagnostic panels.
- Use each surface's existing tokens and primitives: `apps/web/src/app/globals.css` for browser UI, `apps/mobile/src/theme/tokens.ts` for Expo. Native platform typography is intentional, not web Figtree parity. Avoid parallel palettes and one-off variants within either surface.
- Keep errors, loading, empty, unavailable and success states intentional; never make failures resemble empty success.
- Dynamic artwork color is decorative and contrast-safe, with a neutral fallback. Developer diagnostics are opt-in, local-only, bounded and based on actual engine or stored analysis values; never fake codec/throughput/waveform/DSP or upload traces.

## Information architecture

| Destination | Purpose |
| --- | --- |
| Home | Personal recommendations, recent listens and new music |
| Search | Local/external music search plus personalized shelves, radios, mixes, charts and genre discovery |
| Library | Bounded album/artist/song browsing, search, filters and full-collection playback |
| Your Library | Personal playlists and liked songs, with optional imports retaining their distinct ownership |
| Player / Now Playing | Transport, queue and lyrics; never a separate embedded application |
| Settings & management | Provider linking, devices/parties, activity/requests, workers and administration |
| Public pages | Account requests and public activity; anonymous library browsing at `/browse` is retired |

Desktop and mobile lead with Home, Search and Your Library. Search is the single discovery entry; chart and mix detail routes remain reachable from its shelves. The legacy Discover landing redirects to Search, preserving legacy chart/mix query routes. Settings is available from the account control.

The primary Expo client keeps three phone destinations and an adaptive wide
sidebar. Its empty Search is Browse all: real recommendations/new arrivals,
paginated playable-library decades/moods/genres and read-only provider charts.
Cards open distinct destinations; no invented categories, ranks or unsupported
podcast/audiobook/event catalog. Native chart browsing never exposes a chart
acquisition mutation; a missing song can lead to explicit Search resolution.
Operator tools remain on Next.js. See [mobile design](../docs/mobile-design.md).

Move machinery out of the native listening foreground; do not remove backend/admin
tools or existing browser functionality. Sync status, acquisition failures and
necessary user actions still need contextual visibility.

## Playback surface

Keep the audio engine mounted during member navigation. Clicking player title/artwork opens Mint's own Now Playing view, with a large sleeve and Queue/Lyrics tools. Sound configuration, including EQ, normalization, transitions and compatibility, lives in Settings → Playback & sound. Now Playing links there without remounting playback.

On phones, listening content scrolls above pinned transport and safe-area-aware navigation. Do not duplicate competing player bars. Back/Escape returns to the originating view without resetting audio.

Context menus are Mint-owned and accessible through right-click, options buttons, a 550ms touch/pen hold and keyboard invocation. Use the shared `MusicItem` surface for local songs and collections. Movement/scrolling cancels holds, release clicks are suppressed after a hold, and editing fields retain native gestures. Public browsing retains native context menus. Tabs retain arrow/Home/End support; menus support navigation, dismissal and focus return.

Artist names and album titles navigate independently of playback. Album detail heroes use bounded library artwork; artist heroes use only a real Plex grandparent thumbnail through the authorized artwork proxy, with the shared neutral tile when absent. Never treat an album mosaic as an artist portrait. Collection-wide Play/Shuffle remains available. Overview titles/counts are independent of filtered/paginated results.

## Discovery and charts

Search starts with a working, controlled query field; its empty-query state also offers playable playlist shelves, mixes, radio and charts. Generated playlist artwork is acceptable for actual virtual collections; fabricated tracks, popularity claims and human-curation claims are not. Chart and mix detail pages remain dedicated drill-ins, not competing discovery destinations.

Within a chart, distinguish available, missing, ambiguous, requested, processing and failed states in text as well as color. Missing rows are gray/muted but readable; **Add to library** means acquisition, not playback-queue insertion.

Show provider, territory, available ranking period and meaningful stale notices. Publication/refresh timestamps remain in the API for diagnostics. International provider-community charts are not worldwide industry charts.

## Accessibility, motion and writing

- Target 44px touch actions, visible focus, meaningful labels and sufficient contrast.
- Check narrow phones, desktop, long titles, zoom and keyboard flows.
- Use restrained, purposeful motion; respect reduced motion.
- Explain the next action plainly. Avoid backend jargon in daily listening, but preserve technical precision in management.
- Public copy and search/social metadata must describe native Mint playback, not the retired embedded Plexamp experience.
- Never invent adoption metrics, service health, coverage or provider availability.

For visual changes, inspect desktop and mobile together, batch necessary fixes, then do a bounded confirmation pass. Screenshots must show current working UI with fictional/demo content and original or appropriately licensed assets.
