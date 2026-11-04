# Spotify playlist sync

Spotify is an independent, optional read-only metadata source. Mint does not request Spotify playback, library-write or playlist-write scopes, fetch Spotify audio/previews, scrape the website, or use Spotify analysis APIs. Missing songs never enter acquisition queues. Existing YouTube imports and the local library are unchanged.

## Configure the provider

1. Create a Web API application in the [Spotify developer dashboard](https://developer.spotify.com/dashboard). Configure the same separate `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` on Mint's web app and pipeline worker. Never use `NEXT_PUBLIC_` variables for these credentials.
2. Register **exactly** `https://<your-Mint-host>/api/oauth/spotify/callback` as an allowed redirect URI. `PUBLIC_URL` must resolve to that public HTTPS origin. Spotify requires HTTPS except explicit loopback IPs: local development can use `http://127.0.0.1:3000/api/oauth/spotify/callback`, with `PUBLIC_URL` and `ALLOWED_ORIGINS` set accordingly. Spotify does **not** accept `localhost`.
3. Keep the existing shared `ENCRYPTION_KEY`, PostgreSQL and Redis settings on web and worker. Tokens are AES-256-GCM encrypted in the database with the existing key. Losing/changing that key requires reconnecting accounts. No provider secrets/tokens are passed to browser components.
4. For the NAS paste-in deployment, edit only `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` and `SPOTIFY_API_MODE` in the top `x-settings` block. The template passes them to web and worker, not Plex, volunteer agents or the public realtime service. Pull/recreate web and worker with the same database/secrets folders after installing a version containing migration `0010_spotify.sql`; the worker runs migrations at startup. Do not delete data.
5. For standard Compose, use the same entries in `.env`. For a Vercel frontend, set them (and the correct `PUBLIC_URL`) in the server-side Vercel environment **and** the private pipeline worker environment; Redis/PostgreSQL must remain shared. This is separate from Google OAuth.
6. Open **Settings → Spotify playlists**, connect, and grant only `playlist-read-private playlist-read-collaborative`. Choose playlists or paste a canonical `open.spotify.com/playlist/...` link, Spotify playlist URI, or ID. Initial discovery is queued automatically. Use **Sync now** to check immediately; automatic sync checks every 30 minutes when enabled. The worker's scheduler checks due accounts once per minute.

## Spotify's 2026 access restrictions

The default `SPOTIFY_API_MODE=development` uses the current `/me`, `/me/playlists`, `/playlists/{id}` and **`/playlists/{id}/items`** endpoints. New responses use the **`item`** field for each playlist occurrence, not the old `track` field; parsing also understands legacy `track` payloads. An explicit null `item` is never replaced with a legacy field.

The official February 2026 development-mode migration limits playlist contents to playlists the authorized user **owns or collaborates on**. Following a public playlist or possessing its share link is not permission to read its items. Mint only lists owned/collaborative playlists in this mode and reports denied link imports honestly. Spotify may still deny a collaborative playlist depending on the account/app's actual authorization. There is no scraping or endpoint fallback intended to circumvent restrictions.

Development apps require the **app owner's active Spotify Premium subscription**. New limits are **one client ID per developer and five authenticated, allowlisted users per app**; existing apps with additional client IDs/users are grandfathered as described by Spotify. Add members in the app dashboard's Users Management. Login can succeed for an unlisted user while subsequent API calls return 403. Mint does not infer a subscription from `/me.product`, which is deprecated/removed for this API mode.

Only operators who actually have Spotify-approved **extended quota access** should set `SPOTIFY_API_MODE=extended` on both services. Spotify documents extended apps as unaffected by the development migration; this mode deliberately uses the authorized legacy `/playlists/{id}/tracks` endpoint and allows other playlists only when the API returns their contents. It does not grant quota, remove an allowlist, or upgrade an app. Spotify currently accepts extension applications only from qualifying organizations, with restrictive eligibility criteria. No public-app approval is assumed.

The March 2026 changelog restored `external_ids` after its proposed removal. Mint preserves an ISRC when supplied but never requires it: local indexed tracks do not currently have reliable ISRCs, so ISRC data is not falsely advertised as the matching method. `/me.account_id`, when returned, is the stable account-link identity; `id` is separately retained for playlist ownership checks, with legacy account-ID fallback when the new field is absent.

## Local playback and matching

Each playlist owns a separate ordered source snapshot, not rows in the YouTube-only source tables. Provider duplicates, occurrence order, added time/user, IDs/URIs, album, artists and available ISRC metadata are retained. The source remains read-only. Playback uses the **existing Mint player**, with collection `{kind:"spotify", id:<Mint playlist UUID>}`.

Matching is conservative metadata matching, **not audio fingerprint identity**: full normalized title (including live/remaster/version words), complete artists and album must agree, and duration must be within 2.5 seconds. Only locally playable tracks with a Plex rating/library key are candidates. Missing album/duration/artist identity never produces a guess. Multiple candidates produce **ambiguous**, not an arbitrary version. Small metadata differences may intentionally remain missing.

Each occurrence is labelled **matched**, **missing**, **ambiguous**, or **unavailable**. Null/restricted/Spotify-local-file entries and non-music items remain visible but unavailable. Play/Shuffle include only currently playable matched local files, preserving repeated occurrences and source order for non-shuffled playback. A removed/unplayable local file is immediately excluded even before the next metadata sync. Match counts on the overview describe the last successful sync; the source view's playable total is current.

Unchecking a playlist stops future sync, retaining its last snapshot. Disabling automatic sync still permits manual requests. Disconnect removes that user's encrypted Spotify account and source snapshots, **not** local tracks/files. It does not revoke the app in Spotify remotely (no such upstream write is made); users can also remove Mint from their Spotify account's app permissions.

**Copy local matches to Mint** reuses native playlist creation to make an independently editable snapshot, preserving repeated local songs. It supports the existing native limit of 5,000 entries. Missing/unavailable/ambiguous occurrences are not copied, and future Spotify syncs never modify the copy or write to Spotify.

## Reliability and limits

OAuth uses PKCE plus a ten-minute, database-hashed, encrypted-verifier state bound to the exact active Mint session and consumed atomically once. Refresh and sync/disconnect are serialized by an account-specific PostgreSQL advisory lock. Rotated refresh tokens commit even if a subsequent provider request fails. Membership/account authorization and current provider playlist access are rechecked during work; scheduled jobs also recheck the auto-sync preference.

Provider 400/401 authorization failures require reconnect. 403 reports allowlist/Premium/scope/ownership restrictions. HTTP 429 honors `Retry-After` seconds or dates, stores the retry time and blocks immediate retry; scheduled sync resumes after cooldown. Provider bodies are not shown/logged, and generic contract/network failures retain an actionable account/playlist status. A failed or changed/incomplete provider snapshot never replaces the last successful snapshot.

Paging is restricted to the same Spotify host **and endpoint**, consecutive offsets, no cycles, at most 250 pages, and consistent totals. Safety bounds: 5,000 discoverable playlists, 500 selected playlists per account, 10,000 occurrences per playlist, 50,000 local candidates per match, 1,000 API requests and ten minutes per sync run. Requests time out after twenty seconds. Exceeding a limit reports failure rather than silently truncating a playlist. Each source view is paginated in 100-occurrence pages.

## Shared-player server contracts

Exports from `@mint/core/spotify-store`:

- `spotifyQueueTrackSource(db, userId, playlistId): Promise<SQL | null>` returns an authorized id-only SQL source with `track_id` UUID, `source_occurrence_id` UUID, `original_position` integer, source ordered, **without DISTINCT**. Feed it into the shared progressive queue materializer; null means inaccessible. The query itself rechecks active owner/account and local playability.
- `spotifyPlayableQuery(db, userId, playlistId)` returns `{title,total,sourceTotal,query}` or null. Its SQL columns are `track_id`, `occurrence_id`, `position`, and it is ordered by source position.
- `spotifyPlayablePage(db, userId, playlistId, {offset?,limit?})` returns `{title,total,sourceTotal,items:[{trackId,occurrenceId,position}]}` or null. Limits clamp to 1–500; offsets clamp to 0–10,000.
- `spotifyPlaylistView` returns an owner-authorized 100-row source page, including missing/unavailable/ambiguous occurrences and current local-playability correction.

## Validation and external limits

The implementation was validated with **mock Spotify provider contracts and a real isolated PostgreSQL database**, not a live Spotify app/account. No real credentials were available. Production OAuth consent, provider approval, allowlist membership, entitlement and real playlist API behavior still require operator verification. Unit/integration tests cover current/legacy response normalization, confidential token exchange, state replay/session binding, paginated duplicate snapshots, local-only matching, queue authorization, snapshot failures, rate limits, safe rotation, revoked tokens, auto-sync revalidation and disconnect.

Run focused tests:

```sh
# Must be a dedicated test database whose name begins mint_spotify_test.
cd apps/worker
MINT_SPOTIFY_TEST_DATABASE_URL=postgresql://.../mint_spotify_test \
  ../../node_modules/.bin/tsx --test src/spotify.test.ts src/spotify.integration.test.ts
```

Official references researched for this integration:

- [February 2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)
- [February 2026 changelog](https://developer.spotify.com/documentation/web-api/references/changes/february-2026)
- [March 2026 changelog](https://developer.spotify.com/documentation/web-api/references/changes/march-2026)
- [Quota modes, Premium and allowlisting](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)
- [Get playlist items](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items)
- [Current user profile/account identity](https://developer.spotify.com/documentation/web-api/reference/get-current-users-profile)
- [Redirect URI requirements](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri)

Provider access and terms can change independently of Mint; operators remain responsible for their Spotify application's eligibility and compliance.
