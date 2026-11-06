# Design and experience guidance

The current visual contract is [DESIGN.md](../DESIGN.md): **Listening room**, a spacious music service rather than a backend dashboard.

## Identity and hierarchy

- Preserve the dark charcoal/Figtree/mint-green identity. Artwork and music supply the color; mint marks actions and focus.
- Use generous gutters, readable secondary text, quiet controls and clear section separation.
- Prefer coherent collection shelves and artwork-led views over crowded diagnostic panels.
- Use existing tokens in `apps/web/src/app/globals.css` and shared components. Avoid parallel design systems and one-off variants.
- Keep errors, loading, empty, unavailable and success states intentional; never make failures resemble empty success.

## Information architecture

| Destination | Purpose |
| --- | --- |
| Home | Personal recommendations, recent likes and new music |
| Discover | Virtual playlist shelves, radios, mixes, charts and genre discovery |
| Library | Bounded album/artist/song browsing, search, filters and full-collection playback |
| Your collection | Native playlists/likes and imported collections, preserving their distinct ownership |
| Player / Now Playing | Transport, queue and lyrics; never a separate embedded application |
| Settings & management | Provider linking, devices/parties, activity/requests, workers and administration |
| Public pages | Browse-only discovery and requests for access; public activity remains separately reachable |

Desktop and mobile share destinations. Current mobile navigation uses primary bottom destinations and a personal/settings entry. Existing route links must remain usable during navigation changes.

Move machinery out of the listening foreground; do not remove it. Sync status, acquisition failures and necessary user actions still need contextual visibility.

## Playback surface

Keep the audio engine mounted during member navigation. Clicking player title/artwork opens Mint's own Now Playing view, with a large sleeve and Queue/Lyrics tools. Sound configuration, including EQ, normalization, transitions and compatibility, lives in Settings → Playback & sound. Now Playing links there without remounting playback.

On phones, listening content scrolls above pinned transport and safe-area-aware navigation. Do not duplicate competing player bars. Back/Escape returns to the originating view without resetting audio.

Context menus are Mint-owned and accessible through right-click, options buttons, a 550ms touch/pen hold and keyboard invocation. Use the shared `MusicItem` surface for local songs and collections. Movement/scrolling cancels holds, release clicks are suppressed after a hold, and editing fields retain native gestures. Public browsing retains native context menus. Tabs retain arrow/Home/End support; menus support navigation, dismissal and focus return.

Artist names and album titles navigate independently of playback. Artist/album detail heroes use bounded library artwork and collection-wide Play/Shuffle; an artist mosaic represents album sleeves, not an artist portrait. Overview titles/counts are independent of filtered/paginated results.

## Discovery and charts

Discover should feel like shelves of playable collections, not a provider configuration form. Generated playlist artwork is acceptable for actual virtual collections; fabricated tracks, popularity claims and human-curation claims are not.

Within a chart, distinguish available, missing, ambiguous, requested, processing and failed states in text as well as color. Missing rows are gray/muted but readable; **Add to library** means acquisition, not playback-queue insertion.

Keep provider, territory, ranking period, publication/refresh times and stale notices discoverable. International provider-community charts are not worldwide industry charts.

## Accessibility, motion and writing

- Target 44px touch actions, visible focus, meaningful labels and sufficient contrast.
- Check narrow phones, desktop, long titles, zoom and keyboard flows.
- Use restrained, purposeful motion; respect reduced motion.
- Explain the next action plainly. Avoid backend jargon in daily listening, but preserve technical precision in management.
- Public copy and search/social metadata must describe native Mint playback, not the retired embedded Plexamp experience.
- Never invent adoption metrics, service health, coverage or provider availability.

For visual changes, inspect desktop and mobile together, batch necessary fixes, then do a bounded confirmation pass. Screenshots must show current working UI with fictional/demo content and original or appropriately licensed assets.
