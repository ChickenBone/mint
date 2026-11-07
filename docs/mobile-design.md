# Consumer mobile design

The Expo app is a listener-only experience and the design authority for future
consumer UX/UI. It shares Mint's music and account contracts with the web service,
not the web administration interface. Browser consumer UX is frozen,
maintenance-only; existing routes/listening and security/backend compatibility
remain supported, as do the Next.js backend/API and admin tools. Existing
web charts, provider integrations and operator controls remain available. The
only chart surface in the app is a read-only Search category; chart acquisition,
provider setup and operator controls are never routed in the mobile app, even
for an administrator account.

## Visual contract

Music leads: square artwork, compact song rows, charcoal surfaces, readable
secondary text and Mint's green action accent. The native primitives use the
platform sans-serif rather than downloading a font at runtime. Semantic colors,
spacing, typography and responsive geometry live in
`apps/mobile/src/theme/tokens.ts`.

Interactions are independently implemented and Spotify-inspired: familiar
transport, likes, options, direct sheet manipulation and accessible alternatives,
not proprietary assets or a claim of exact feature/animation parity. Dynamic
gradients derive from actual artwork and remain bounded, decorative and readable;
neutral backgrounds and music tiles handle missing or failed art.

The visual contract is shared; implementation ownership is feature-local under
`apps/mobile/src/features/`. Albums and artists have their own entry screens,
not branches of an editable-playlist screen. Reusable detail rendering, music
rows and page styles remain foundation presentation, without importing Home.
See [feature ownership](mobile.md#feature-ownership) before loading unrelated
screens for a focused change.

Home, Search and Your Library have an account avatar alongside the page title,
not a branded header. Phones have three bottom destinations. At 900px and above,
these become a persistent sidebar. Content scrolls independently of the
mini-player and navigation. Safe-area insets protect persistent controls.
Interactive controls have at least 44px targets and explicit accessible names;
status is communicated in text, not color alone. Motion explains state and
direct manipulation, respects reduced motion and does not compete with listening.
Artwork failure shows a neutral music tile; artist portraits never
substitute album artwork.

The persistent player provider wraps the route outlet. Its mini-player sits
above phone navigation; expansion and the `/player` deep link open the same
player presentation without creating another engine. Album-art-derived player
color belongs to the current listening context, not the entire app chrome.

The player uses one measured cover through expansion, collapse and interrupted
dragging, not competing mini/expanded images. Vertical title/artwork dragging
opens the sheet; directional horizontal mini-player swipes move previous/next.
Expanded header/artwork/metadata allow collapse, leaving seek, buttons and
lyrics/queue scrolling independent. Explicit transport, open/close, Back/Escape
and accessibility actions preserve non-gesture access. UI-thread worklets and
reduced-motion handling are implementation choices, not measured device FPS.
The mini-player keeps Shuffle, Play/Pause and Next together in one control row,
including narrow phones. Title/open and artist navigation have separate
nonoverlapping touch targets; the loading indicator overlays artwork instead of
consuming another control slot. Seek preview and commit are occurrence/account
scoped so a previous track's slider event cannot seek the newly selected track.

## Listener flows

- **Home:** bounded personal recommendations, album browsing, recent additions
  and rediscovery when listening history supports it. Empty shelves are not
  filled with invented tracks or popularity claims.
- **Search:** automatic local song/album/artist search and an independent
  MusicBrainz recording search. Query changes cancel stale requests; partial
  provider failure does not hide working library results. Only an explicit
  **Add to library** action requests missing music. Browsing and Play never
  acquire audio. A requested recording is not labeled playable.
- **Browse all:** an empty Search shows a virtualized grid of category cards
  (two columns on phones, up to five on wide screens) in fixed section order:
  For you, Charts, Decades, Moods, Genres. Every card comes from real
  data: discovery mixes appear only when they have songs, New arrivals only
  when albums exist, and decades/moods/genres are paginated from playable songs
  and mint-dsp analysis with true song counts. Card color is a deterministic
  deep tone that keeps white titles above 4.5:1 contrast; a rotated cover is a
  real sample from that category, otherwise a glyph. Categories open
  `/browse/[facet]` inside the Search tab: filtered categories offer full
  Play/Shuffle, an album shelf and paged songs; charts show provider ranks,
  period and per-row library status. Available chart songs play; missing ones
  offer a Search shortcut, never automatic acquisition. A chart that updates
  while paging asks to reload instead of mixing revisions.
- **Your Library:** liked songs, native and collaborative playlists, smart
  playlists, source-managed imports, existing folders/pins, playlist invitations,
  albums, artists and songs. Native playlist
  creation, rename, copy, song addition/removal and occurrence-based reordering
  use revision-checked server mutations. Source-managed playlists remain
  read-only; making a copy creates a separate native playlist. Only owners see
  playlist deletion.
- **Details:** album, artist, playlist and liked-song routes retain full-selection
  Play/Shuffle while rendering bounded song windows. Artist and album navigation
  is distinct from playback. Duplicate playlist entries keep their own identity.
- **Song options:** queue insertion, likes, playlist addition and supported
  offline downloads. Smart/source-managed playlists are not offered as manual
  song-addition targets. Player hearts and song options share account/API-scoped
  like state with pending/confirmed/error feedback and confirmed liked-list
  invalidation; small individual lookups do not download the entire liked library
  or add polling.
- **Settings:** account connection, private sessions, history deletion,
  device-local download storage, optional MP3 compatibility, supported playback information, issue reporting
  and sign-out. Developer options enables the local-only Stats for nerds panel
  in the player; it does not add a pipeline dashboard or infrastructure panel.

Developer diagnostics are opt-in and local-only: traces are not uploaded,
automatically appended to reports or used as telemetry. Stored analysis must be
labeled separately from live audio-engine observations; unavailable codec,
throughput, waveform or DSP data stays unavailable, not synthesized.

Issue reports send only explicitly written content. Destructive listener actions
require confirmation. Loading, empty, failed and unavailable states are distinct,
with retry or an actionable explanation.

## Truthful limits

The app does not present DSP, Smart Fades or guaranteed gapless playback as
implemented capabilities. Native background playback depends on the configured
build and operating system; browser suspension remains possible. Offline storage
is account-scoped and device-local, not proof that a server acquisition completed.
No commercial-service screenshots, artwork, proprietary assets or source code
are bundled in this implementation.
