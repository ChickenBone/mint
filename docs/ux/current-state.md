# Mint UX current state

## Verified in app

**Verification date:** 2026-11-04
**Environment:** disposable `mint_redesign_demo` Postgres database, isolated loopback Redis, fictional seeded catalog, and Chromium at 390×844 and 1440×1000. Sign-in used the fixture account and an ephemeral test-only password. No production service or library was accessed.

The sign-in → search → play → Library → Now Playing → create playlist → add a song → Downloads journey completed in **19 discrete interactions**:

| Task | Interactions | Observed behavior |
| --- | ---: | --- |
| Sign in | 3 | Enter email and password, submit. |
| Find and play a song | 3 | Open Search, enter a title, select Play. Search currently occupies the music browser rather than a global overlay. |
| Open Library | 2 | Select Library, then select Songs; the route initially opens Albums. |
| Open Now Playing | 1 | Select the artwork/title in the persistent player dock. |
| Create a playlist and add the song | 9 | Open Your collection, expand creation, name and create, return to Library, choose Songs, open the row menu, open playlist choices and select a playlist. |
| Reach Downloads | 1 | At desktop width, use the sidebar. The mobile navigation has no Downloads destination. |

Playback started from Search and remained on the same audio element while navigating to Library. Now Playing, playlist creation, and Downloads remained reachable afterward. The player dock consumes two rows on phone widths, in addition to the five-item bottom navigation. The Search screen shows library-category buttons, collection playback controls and filters alongside the query, so search and catalog browsing are not clearly separated. Library requires an extra tab selection to reach songs. Adding a song depends on the existing row menu and a previously created Mint playlist.

The first ad-hoc preview pass used a playback-only local gateway rather than the fixture's artwork endpoint; it produced artwork-worker 503 console messages. Those are a preview-harness limitation, not counted as a verified product failure. The completed journey itself did not report a client exception. Baseline screenshots were kept in temporary session storage and are not repository assets.

## Verified after rebuild

The isolated browser journey now exercises persistent Search, direct song playback, Library, Now Playing, shared row actions, playlist creation and Undo, Downloads, device navigation, legacy redirects, and the responsive shell. The same mounted audio element continued playing across Home, Discover, Library, Downloads, Now Playing and Devices. Screenshots were captured at 360, 390, 768 and 1440 pixels; an additional 320-pixel small-screen check found no horizontal overflow.

The same success path is estimated at **15 interactions** (or 16 if the optional Undo is counted), down from 19: Sign in 3; Search and play 3; open Library 1; open Now Playing 1; create and add through the track menu 5; reach Downloads through the track menu 2. Library opens on Songs, so the former extra tab selection is gone. Search now opens in place, groups live results, and restores focus on Escape.

The browser fixture's full-document teardown navigation can abort a pending listening-history `keepalive` request; the app reports that rejected write, and the fixture recognizes only that teardown cancellation while still asserting on other browser errors. A duplicate-edition chart stress case proved flaky and was excluded from the final run; chart acquisition, deduplication, and provider error/empty states remain exercised.

An optional extended screenshot pass also observed a React hydration error on `/app/admin`. Management is outside this phase and was not changed; that route was excluded from the final in-scope screenshot run.

## Spec availability

The requested `docs/ux/target-ux.md` and prior `docs/ux/current-state.md` were not present in the checkout. The target route plan and success-measure assumptions are recorded in [target-ux.md](target-ux.md); those assumptions are not claims about a previously approved section 8.
