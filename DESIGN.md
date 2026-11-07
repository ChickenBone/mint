# Mint · Music first

Mint is a listening service, not a pipeline dashboard. Its navigation and everyday controls should feel familiar to people who use established music apps, while using Mint's own branding, implementation and assets. Charcoal surfaces reduce glare; artwork supplies color. Figtree and the mint-green action accent identify Mint.

## Direction contract

**Thesis:** music and personal collections lead; the machinery stays available without competing for attention.
**World:** cool charcoal fields, square artwork, compact rounded controls, readable secondary text, and mint reserved for action/focus. A restrained blue/teal wash establishes listening atmosphere; lavender identifies the Liked songs sleeve. Administrative surfaces stay opaque and neutral.
**Path:** Home, Search and Your Library lead. Search combines query-based lookup with personalized discovery shelves; charts and mixes remain dedicated drill-in routes. The old Discover landing redirects to Search. Settings holds personal preferences and optional imports; the admin portal holds server operations.
**First viewport:** navigation, familiar music shelves and an anchored transport. Phones retain the same primary destinations and persistent playback.
**Signature:** a requested chart recording becomes a full-color playable song in place. Navigation and Now Playing never recreate the audio engine.

**Search & Explore:** Search is the single entry for finding music and starting discovery. The focused query searches local and external recordings; the empty-query view includes browse shortcuts, personalized playlist shelves, artist radio, genres and charts. Dedicated mix and chart routes retain their detailed flows, with back links returning to Search. Generated covers carry oversized typography, a confident color palette and small Mint/source credits. These are virtual playlists, never fabricated songs, rankings or claims of human curation. Provider details and acquisition controls belong inside the selected chart.

## System

- Tokens live in `apps/web/src/app/globals.css`. Use background, surface, elevated and hover as four restrained levels, not nested panel decoration. `gradient-action` enriches mint primary controls, `gradient-atmosphere` belongs to music headers, and `gradient-liked` identifies personal favorites; never gradient text, glowing borders or rainbow chrome. `info` and `accent` are complementary roles, not a replacement for warning/error semantics.
- Figtree is the only typeface. Titles use a compact 32–64px scale, section headings 24–32px, body 14–16px. Long explanations stay below 75 characters per line.
- Content gutters scale from 20px on phones to 48px on wide screens. Listening content is bounded by `content-max`; related controls use `space-control-gap`, panels use `space-panel`, and sections have 40–48px separation. Ordinary page headings use a compact 32–48px scale; album/artist titles stop at 64px. Shelves keep comfortable desktop density; personal collection sleeves stay smaller than album sleeves. Settings and the admin frame are narrower and quieter.
- Primary controls are mint with dark ink. Secondary controls use neutral fills or quiet outlines. Destructive and warning states use danger/warn, never mint.
- Touch actions target 44px. Focus is visible. Inputs always have names; ranked rows retain their order and state in accessible text, not color alone.
- The player is one anchored three-part surface: song identity, centered transport/seek, then lyrics, queue and mute/volume. The compact phone dock keeps playback and direct queue access with a quiet progress edge. Now Playing pairs the sleeve with Queue / Lyrics, retaining arrow/Home/End tab navigation and pinned phone transport. EQ and all sound configuration live in Settings → Playback & sound, linked from Now Playing.
- Album pages lead with large real library sleeves; artist pages use real Plex artist thumbnails with a readable full-bleed title treatment and neutral fallback. Never substitute album art or invented portraits. Artist pages may show source-linked MusicBrainz identity/relationships, Wikipedia summaries with CC BY-SA attribution, and ListenBrainz community counts; label community counts as provider-specific, not global popularity. Artist names and album titles remain separate navigation targets throughout member listening views.
- Songs, collection sleeves, recommendations, local chart entries, downloads and queue rows share right-click, 550ms touch/pen hold, options-button and Context Menu/Shift+F10 actions. Movement cancels a hold; releasing a hold never also plays or navigates. Inputs keep native editing gestures, and public browsing keeps native context menus.
- Motion is brief and purposeful: the existing sleeve reveal and a muted-to-playable chart transition. Reduced motion removes animation and nonessential transitions.
- Failed artwork uses the shared neutral music tile. Never invent covers, counts, chart ranks or playback availability.
- Album, playlist and Now Playing headers can reuse `ArtworkAtmosphere` with the existing artwork URL. Color comes directly from the image, without canvas sampling, another provider, or a parallel cache. The decorative layer is clipped to a bounded header, pointer-inert and hidden from assistive technology; a dark scrim keeps foreground contrast independent of artwork brightness. Missing/failed art leaves a neutral background. Do not use full-screen backdrop blur, continuous image animation or glass over forms, menus, queue rows or errors.

## Navigation and capability map

| Capability | Home in the redesigned app |
| --- | --- |
| Recommendations, recent likes, new arrivals | Home |
| Query-based local and external music search, personalized shelves and discovery entry | Search |
| Provider charts, territory Top 50, weekly community/trending collections | Search → Explore → playlist cards / All charts |
| Personal discovery, radio, multi-seed/sonic mixes, rediscovery, saved mixes | Search → Explore → Your mixes |
| Native albums/artists/songs, search, metadata filters, full-collection queues/shuffle | Library |
| Native/editable/smart/collaborative playlists, folders/pins and liked songs | Your Library |
| YouTube imports and existing sync controls | Optional import / Settings → Music imports |
| Spotify metadata playlists and account linking | Settings → Music imports |
| Persistent playback, seek, repeat, queue editing | Player / Now Playing |
| DSP/EQ, normalization, Smart Fades, playback compatibility | Settings → Playback & sound |
| Lyrics and issue reporting | Player → Lyrics; reports in Admin → Reports |
| Personal lyric-match corrections and diagnostics | Player → Lyrics → Admin details (admins only) |
| Account-scoped offline downloads, storage/retry/removal | Downloads |
| Private history, private sessions and history deletion | Listening history |
| Devices, explicit handoff and single-output parties | Settings → Devices & parties |
| Job stages/errors, retry/cancellation and request progress | Settings → Activity & requests |
| Sync settings/status and account requests/approval | Settings / Admin |
| Worker registration, ownership, approval and revocation | Settings → Workers / Admin |
| Analysis controls, backfills, coverage and diagnostics | Settings → Admin → Audio analysis |
| Service diagnostics, read-only Plex indexing/setup | Settings → Admin |
| Public browsing, chart availability and account requests | Public Library / Charts / Request access |
| Public pipeline visibility | Public footer → Library activity |
| Docker, GHCR, migrations and CI/CD | Existing deployment tooling and self-hosting guide |

Existing routes remain valid. Public visitors never receive player items or media authorization from charts. Only an explicit authorized request can enter acquisition; Play skips missing/uncertain entries and reports that fact.

## Charts and recording safety

Every chart identifies its provider, audience/territory and available ranking period. Provider publication and Mint check times remain in the API for diagnostics rather than crowding the listening screen. “Worldwide” describes only the named provider's community, never an inferred global industry chart. Apple genre labels are metadata, not independent genre rankings; Audius supplies its own genre-specific trending collections.

Missing recordings are muted but readable and have a labeled Add to library action. Requested, processing, failed and ambiguous states have distinct text. Ambiguous identity opens a recording/source chooser instead of silently playing or acquiring. Matching retains version words, compares duration and identifiers where present, and never strips remaster/live/remix qualifiers.

Charts are bounded to 50 entries, paginated in 25-entry windows, server-cached and provider-throttled. Stale rankings, provider failures and genuinely empty results are different states. WebSocket invalidation is supplemented by visible-tab polling so a failed realtime connection never hides progress.

The desktop analysis-worker “Analysis result not accepted fetch failed” report remains an unresolved operational investigation, not a verified redesign fix.
