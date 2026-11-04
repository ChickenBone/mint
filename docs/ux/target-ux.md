# UX rebuild target: foundations and core listening

> **Assumption note:** The originally referenced target UX document was not present in this checkout. This plan records the route and measurement assumptions used to implement the user's Prompt 1 scope. It does not claim to reproduce unavailable wireframes, state-matrix details, or section 8 measures.

## 1. Information architecture

Primary destinations are Home (`/app`), Discover (`/app/discover`), Library (`/app/library`) and Your music (`/app/collections`). Desktop uses a full navigation rail; tablet uses a collapsed icon rail; phone uses four bottom destinations and an avatar entry to existing Settings. Search is a persistent top-bar action and a desktop `/` shortcut. The player provider remains above routed content so navigation cannot recreate the audio engine.

Discover keeps its existing content and provider behavior while giving mixes and charts named routes:

| Destination | Canonical route |
| --- | --- |
| Discover home | `/app/discover` |
| Mixes | `/app/discover/mixes` |
| Mix detail | `/app/discover/mixes?mode=…&seed=…` using existing mix modes and bounded seed IDs |
| Charts | `/app/discover/charts` |
| Chart detail | `/app/discover/charts/[chart]` |
| Library | `/app/library` |
| Album detail | `/app/library/albums/[id]` |
| Artist detail | `/app/library/artists/[id]` |
| Search overlay | In-place overlay; `/app/search` is the shareable/fallback search surface |
| Now Playing | `/app/now-playing` |

Existing `/app/music` views, `/app/library` query tabs, and discovery query tabs remain valid through redirects or compatible query handling. Settings, Your music, playlist, Spotify, Downloads, history, device and management routes retain their current destinations in this phase.

## 2. Core flows and assumed measures

No prior success-measure values were available. Baseline and follow-up counts use the same seeded tasks and count explicit clicks, key activations, and text-entry submissions (not browser navigation or waiting).

| Flow | Verified baseline | Assumed target |
| --- | ---: | ---: |
| Sign in → search and play → Library → Now Playing → create playlist and add song → Downloads | 19 interactions at 390px / 1440px | At most 16 interactions, without a route reload or audio-engine replacement |
| Search with keyboard | No global-search keyboard behavior in baseline | `/` opens and focuses Search on desktop; Escape closes and restores focus |
| Route continuity | Same audio element continued across Library navigation | Same mounted audio element and progressing playback across every touched route |
| Responsive shell | Phone has a two-row dock and five bottom destinations; Downloads is not in phone navigation | Four primary phone destinations, accessible Settings entry and a compact persistent player |

These are implementation checkpoints inferred from the request, not historical targets.

## 3. Shared interaction and visual contract

- Preserve the Listening room charcoal levels, Figtree, mint action/focus accent, reduced-motion behavior, visible keyboard focus and 44px minimum touch targets.
- Provide skip navigation, one primary content landmark, a navigation landmark and a persistent player.
- Search results are grouped by Songs, Artists and Albums and retain recent searches. Preserve local-library matching, explicit missing-music requests and their existing authorization boundary.
- Use one shared track action menu across in-scope song rows: play next, queue, playlist (recent playlists and create), like, artist/album navigation and download. Confirm successful playlist additions with an undoable toast.
- Preserve existing queue snapshots, bounded catalog windows, full-collection shuffle, read-only originals, account isolation and private media authorization.
- Keep chart provider/territory/period/publication details and explicit acquisition in chart detail. Do not invent artwork, availability, rankings or counts.
- Home offers Continue listening, Made for you and New arrivals, with at most one dismissible setup prompt and one primary action.

## 4. Screen-state coverage

For each in-scope route and panel, distinguish:

| State | Expected presentation |
| --- | --- |
| Loading | Skeletons with stable layout and useful accessible status. |
| Empty | Context-specific explanation and a next action only when one exists. |
| Error | Explicit problem, retry/recovery where supported; never imply success. |
| Offline | Explain which data/actions remain available and how to reconnect. |
| Unavailable | Explain capability or provider unavailability distinctly from empty data. |

Loading, empty, error, offline and unavailable states must not rely on color alone. Reuse existing error, offline and provider contracts; no API/schema changes are assumed by this route and shell plan.

## 5. Scope boundary

This phase covers the shell, route consolidation, global search, Home, Discover, Library, Now Playing and shared track actions. Your music consolidation, Settings restructuring, Management, onboarding, public pages and Settings copy cleanup remain deferred to part 2.
