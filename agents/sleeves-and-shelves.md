# Playlist sleeves, discovery shelves and demo assets

## Two different kinds of covers

**Library album art** represents a recording/release and follows the Plex-first artwork pipeline. Do not generate imaginary replacement album art for a real user's library or substitute provider promotional art without reviewing permitted use.

**Mint virtual-playlist sleeves** represent an actual mix, radio or chart collection. Original generated artwork is appropriate because it identifies the collection, not an invented recording.

The current implementation lives in:

- `apps/web/src/components/app/discovery-shelves.tsx`: `PlaylistCover`, mix definitions, chart-to-collection mapping and shelf actions.
- `apps/web/src/app/globals.css`: `discovery-cover`, sleeve typography, shapes, credits, shelf rails and play affordances.
- [DESIGN.md](../DESIGN.md): visual contract and navigation map.

Reuse these before introducing another card/cover renderer.

## Sleeve composition

- Square format, oversized short typography, a deliberate paper/ink palette and restrained original geometric marks.
- A small Mint/source credit clarifies ownership and collection provenance.
- Keep text readable at card size, not only on a full-size canvas. Long artist/genre names must not collide with credits.
- Collection imagery can include an existing seed's album art as a subdued layer, but must not imply a provider supplied the generated cover.
- Generated titles should match what the collection actually opens: daily mix, rediscovery, artist radio, country Top 50 or a provider-scoped genre chart.
- Never invent a chart badge, sales rank, editorial endorsement or human-curation claim.

Current cover palettes are separate collection-art materials, not permission to recolor app chrome. Preserve mint as the action/focus accent and the established neutral surfaces.

Generated visual elements are decorative (`aria-hidden`) where an adjacent linked title and accessible Open/Play labels provide the meaning. Do not encode availability, provider scope or error state only in sleeve art.

## Shelf behavior

Search discovery begins with playlist-led shelves: daily/library mixes, artist radio, provider charts, genre discovery and country exploration. The old Discover landing redirects to Search. Provider controls and detailed rank rows belong inside the selected chart, not in a dense discovery form.

Expo Search also provides a Browse all grid using its shared `BrowseCard`
primitive: real sample covers or neutral glyphs, true counts and distinct
paginated categories. Reuse the native component/token contract rather than
copying browser CSS. See [mobile design](../docs/mobile-design.md).

- Use native links for opening a collection, with stable route/state.
- A mix Play action plays a real playable selection; it must not be a decorative button.
- Current chart cards open ranked collections; do not pretend every external recording is locally playable.
- Horizontal rails should be swipeable on phones and usable by keyboard without creating document-level overflow.
- Titles/descriptions remain outside decorative art, readable and consistent.
- Hover-only Play affordances need equivalent keyboard/touch access and proper loading/disabled states.
- Preserve selected collection context when returning from Now Playing or management.

Chart missing-to-playable transitions should feel intentional but must follow real availability updates. Do not animate an unavailable item into apparent success before the job completes.

## Fictional demo artwork and audio

Use original synthetic assets for screenshots. The committed preview generates SVG album sleeves into PNG with `sharp`, and a quiet PCM WAV in memory. Those represent fictional recordings only.

When extending generated SVG:

- Escape XML text after case conversion and before interpolation; an unescaped ampersand can make the SVG fail to decode.
- Use deterministic geometry/palettes and enough distinct album identities to reveal accidental grouping duplicates.
- Keep generated music/names obviously demo-only in documentation and fixture notices.
- Avoid commercial album covers, copyrighted audio, personal libraries or a provider's promotional preview assets.

For raster generation, `sharp(Buffer.from(svg)).png().toBuffer()` produces actual image bytes for the same-origin artwork route. Serve the correct MIME and exercise browser decoding. Do not merely screenshot inline placeholders and claim the image pipeline works.

For fixtures around production artwork, model multiple songs sharing one album and include Plex failure/public fallback cases. Assert primary/fallback bytes and request coalescing; this caught regressions that a visual-only check could miss.

## Screenshots and evidence

Store selected public documentation screenshots in `docs/screenshots/`; keep one-off contact sheets, counters and temporary evidence out of the public tree unless explicitly requested.

Screenshots must be captured from the working app, with matching desktop/mobile content and no actual secrets or personal identity. Clearly label synthetic rankings/activity; never display fictional fixtures as a real provider snapshot.

Keep the album wall/mosaics grouped by album identity: per-track artwork URLs are not distinct album identities. Verify actual visible covers decode, not just that `<img>` elements exist.

See [browser testing and mocks](browser-testing-and-mocks.md) for the complete repeatable capture and validation workflow.
