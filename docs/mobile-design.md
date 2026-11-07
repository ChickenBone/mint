# Consumer mobile design

The Expo app is a listener-only experience. It shares Mint's music and account
contracts with the web service, not the web administration interface. Existing
web charts, provider integrations and operator controls remain unchanged; none
are promoted or routed inside the mobile app, even for an administrator account.

## Visual contract

Music leads: square artwork, compact song rows, charcoal surfaces, readable
secondary text and Mint's green action accent. The native primitives use the
platform sans-serif rather than downloading a font at runtime. Semantic colors,
spacing, typography and responsive geometry live in
`apps/mobile/src/theme/tokens.ts`.

Home, Search and Your Library have an account avatar alongside the page title,
not a branded header. Phones have three bottom destinations. At 900px and above,
these become a persistent sidebar. Content scrolls independently of the
mini-player and navigation. Safe-area insets protect persistent controls.
Interactive controls have at least 44px targets and explicit accessible names;
status is communicated in text, not color alone. Nonessential animation is
omitted. Artwork failure shows a neutral music tile; artist portraits never
substitute album artwork.

The persistent player provider wraps the route outlet. Its mini-player sits
above phone navigation; expansion and the `/player` deep link open the same
player presentation without creating another engine. Album-art-derived player
color belongs to the current listening context, not the entire app chrome.

## Listener flows

- **Home:** bounded personal recommendations, album browsing, recent additions
  and rediscovery when listening history supports it. Empty shelves are not
  filled with invented tracks or popularity claims.
- **Search:** automatic local song/album/artist search and an independent
  MusicBrainz recording search. Query changes cancel stale requests; partial
  provider failure does not hide working library results. Only an explicit
  **Add to library** action requests missing music. Browsing and Play never
  acquire audio. A requested recording is not labeled playable.
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
  song-addition targets.
- **Settings:** account connection, private sessions, history deletion,
  device-local download storage, optional MP3 compatibility, supported playback information, issue reporting
  and sign-out. There is no download pipeline dashboard or infrastructure panel.

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
