# Mint · Listening room

The approved redesign is a spacious listening service, not a pipeline dashboard. A listener opens Mint on a desk or a dimly lit phone to find a song and stay with it. Charcoal surfaces reduce glare; artwork supplies color. Figtree and the mint-green action accent preserve Mint's identity.

## Direction contract

**Thesis:** music leads; the machinery stays available without competing for attention.
**World:** broad charcoal fields, generous gutters, square sleeves, quiet rounded controls, readable secondary text, and mint reserved for action/focus.
**Path:** Home → Discover → Library; personal collections sit alongside these. Settings is the doorway to integrations and management.
**First viewport:** a quiet navigation rail, an artwork-led listening invitation, a single play action, and a persistent transport. On phones Home, Discover, Library and Your collection share the bottom bar; the You destination remains the doorway to Settings.
**Signature:** a requested chart recording becomes a full-color playable song in place. Navigation and Now Playing never recreate the audio engine.

**Discover:** Spotify-style playlist shelves, not a chart administration form. Original generated covers carry oversized typography, a confident color palette and small Mint/source credits. Daily blend, Fresh finds, rediscovery and artist radio open real library mixes; chart and genre covers open their actual ranked collections. Horizontal shelves remain swipeable on phones. These are virtual playlists, never fabricated songs, rankings or claims of human curation. Provider details and acquisition controls belong inside the selected chart.

## System

- Tokens live in `apps/web/src/app/globals.css`. Use background, surface, elevated and hover as four restrained levels, not nested panel decoration.
- Figtree is the only typeface. Titles use a compact 32–64px scale, section headings 24–32px, body 14–16px. Long explanations stay below 75 characters per line.
- Content gutters scale from 20px on phones to 48px on wide screens. Related controls form small groups; sections have 40–64px separation.
- Primary controls are mint with dark ink. Secondary controls use neutral fills or quiet outlines. Destructive and warning states use danger/warn, never mint.
- Touch actions target 44px. Focus is visible. Inputs always have names; ranked rows retain their order and state in accessible text, not color alone.
- The player is one anchored three-part surface: song identity, centered transport/seek, then lyrics, queue and mute/volume. The compact phone dock keeps playback and direct queue access with a quiet progress edge. Now Playing pairs the sleeve with Queue / Lyrics, retaining arrow/Home/End tab navigation and pinned phone transport. EQ and all sound configuration live in Settings → Playback & sound, linked from Now Playing.
- Album pages lead with large real library sleeves; artist pages use real Plex artist thumbnails with a readable full-bleed title treatment and neutral fallback. Never substitute album art or invented portraits. Artist pages may show source-linked MusicBrainz identity/relationships, Wikipedia summaries with CC BY-SA attribution, and ListenBrainz community counts; label community counts as provider-specific, not global popularity. Artist names and album titles remain separate navigation targets throughout member listening views.
- Songs, collection sleeves, recommendations, local chart entries, downloads and queue rows share right-click, 550ms touch/pen hold, options-button and Context Menu/Shift+F10 actions. Movement cancels a hold; releasing a hold never also plays or navigates. Inputs keep native editing gestures, and public browsing keeps native context menus.
- Motion is brief and purposeful: the existing sleeve reveal and a muted-to-playable chart transition. Reduced motion removes animation and nonessential transitions.
- Failed artwork uses the shared neutral music tile. Never invent covers, counts, chart ranks or playback availability.

## Navigation and capability map

| Capability | Home in the redesigned app |
| --- | --- |
| Recommendations, recent likes, new arrivals | Home |
| Provider charts, territory Top 50, weekly community/trending collections | Discover → playlist cards / All charts |
| Personal discovery, radio, multi-seed/sonic mixes, rediscovery, saved mixes | Discover → Your mixes |
| Native albums/artists/songs, search, metadata filters, full-collection queues/shuffle | Library |
| Native/editable/smart/collaborative playlists, folders/pins and Mint likes | Your collection |
| YouTube likes and imported playlists | Your collection / Settings → YouTube Music |
| Spotify metadata playlists and account linking | Your collection / Settings → Spotify |
| Persistent playback, seek, repeat, queue editing | Player / Now Playing |
| DSP/EQ, normalization, Smart Fades, playback compatibility | Settings → Playback & sound |
| Lyrics and personal lyric-match corrections | Player → Lyrics |
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

Every collection identifies provider, audience/territory, ranking period, provider publication time and Mint check time. “Worldwide” describes only the named provider's community, never an inferred global industry chart. Apple genre labels are metadata, not independent genre rankings; Audius supplies its own genre-specific trending collections.

Missing recordings are muted but readable and have a labeled Add to library action. Requested, processing, failed and ambiguous states have distinct text. Ambiguous identity opens a recording/source chooser instead of silently playing or acquiring. Matching retains version words, compares duration and identifiers where present, and never strips remaster/live/remix qualifiers.

Charts are bounded to 50 entries, paginated in 25-entry windows, server-cached and provider-throttled. Stale rankings, provider failures and genuinely empty results are different states. WebSocket invalidation is supplemented by visible-tab polling so a failed realtime connection never hides progress.

The desktop analysis-worker “Analysis result not accepted fetch failed” report remains an unresolved operational investigation, not a verified redesign fix.
