# Chart discovery

Mint uses documented, server-side, keyless public feeds. No paid chart account, Spotify session cookie, private Google endpoint or scraping workaround is required. Open a playlist cover in **Discover → In heavy rotation / Find your frequency**, or `/charts` for public, browse-only access. Discover's generated covers are virtual collections backed by real library mixes or provider rankings, not fictional track lists.

## Coverage and provider research

| Provider | What Mint actually shows | Authentication and limits | Scope and permitted use |
| --- | --- | --- | --- |
| Apple Music | Most-played Top 50 for US, UK, Canada, Australia, Japan, Germany and France. Feed publication time is displayed; Apple does not publish this ranking's measurement window. | Official RSS requires no key. One feed plus one batched iTunes ID lookup per refresh. Apple documents approximately 20 Search API calls/minute, subject to change; no numeric RSS SLA was found. | **Country storefronts, not worldwide.** The current generator does not offer a verified genre-chart feed. ID lookup supplies duration/album metadata; Mint does not reuse Apple promotional images, previews or audio. Apple links remain visible. |
| ListenBrainz | Weekly sitewide Top 50 recordings, with the actual `from_ts`/`to_ts` period and publication time. Original ranks, including release variants sharing a recording, are retained. | Public statistics require no token. Published guidance limits clients to one request/second and requires an identifying User-Agent. | **Worldwide ListenBrainz listeners, not worldwide music-market sales/streams.** Listen data is CC0; metadata grants no audio rights. Published weekly statistics can lag: Mint marks old publications stale even after a successful refresh. |
| Audius | Weekly platform trending Top 50; Electronic, Hip-Hop/Rap, Pop, Rock and Jazz collections use the documented genre filter. | Public read endpoints currently work without a key using `app_name=Mint`. Anonymous access has lower limits; a reliable published numeric quota was not verified. Mint honors HTTP 429/Retry-After. | **Worldwide Audius catalog, not all worldwide music.** Trending is Audius's algorithm, not an industry chart. No publication timestamp is supplied by this endpoint; the UI says so. Metadata access does not authorize downloading uploads; Mint never streams Audius audio. |

There is **no claim of a keyless, worldwide industry Top 50** and no synthetic “global” aggregation of country charts. Apple provides US mainstream coverage; the two international sources provide explicitly labeled community/independent discovery. Genres cover Audius's catalog only. A complete worldwide mainstream/genre chart would need an appropriately licensed provider.

Last.fm was not selected because an API key is required and public/commercial uses have additional terms. Spotify's official APIs require authorization and have playlist restrictions; they are not a keyless global-chart replacement. YouTube's official Data API requires credentials and is not an equivalent verified worldwide music chart. Deezer was not added because its current public documentation, permitted use and worldwide-feed semantics could not all be verified.

Research and live endpoint checks were performed in November 2026. Access is not an availability guarantee or a perpetual license. Review upstream terms before publishing a public/commercial instance; this integration is designed for the requested private self-hosted use. Only acquire music you are authorized to download, store and share.

Official references:

- [Apple RSS generator](https://rss.marketingtools.apple.com/), [US feed](https://rss.marketingtools.apple.com/api/v2/us/music/most-played/50/songs.json), [Search API overview and usage restrictions](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/index.html), [ID lookup](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/LookupExamples.html).
- [ListenBrainz statistics](https://listenbrainz.readthedocs.io/en/latest/users/api/statistics.html), [API authentication/rate guidance](https://listenbrainz.readthedocs.io/en/latest/users/api/index.html), [data license](https://listenbrainz.org/data/).
- [Audius documented track/trending API](https://docs.audius.co/sdk/tracks/), [API reference](https://docs.audius.co/api/), [terms](https://audius.co/legal/terms-of-use).

## Configuration and resilience

Charts are enabled by default on the **web** service. No new provider secrets are needed. Web needs PostgreSQL, Redis and outbound HTTPS to `rss.marketingtools.apple.com`, `itunes.apple.com`, `api.listenbrainz.org` and `api.audius.co`. Explicit recording resolution additionally uses `musicbrainz.org`; normal local browsing/search does not.

Set `MINT_CHARTS_ENABLED=false` in the command-line `.env`, or change its value on the NAS template's web service, then recreate web to disable external chart requests. Existing playback and collection discovery are unaffected. A disabled instance or unavailable Redis produces an explicit unavailable state, never invented rankings.

- Refreshes are demand-driven, shared across accounts, cached for one hour and retained for at most seven days. The browser requests at most 25 ranked entries per page.
- Each provider has a distributed ten-second minimum request spacing. Apple uses at most two outbound calls per refresh. A distributed 30-second refresh lease prevents duplicate refreshes.
- Provider calls have eight-second timeouts, two-megabyte response caps, fixed hosts, rejected redirects and validated bounded results. A refresh never downloads library metadata into the browser.
- Failures retain bounded stale rankings with a reason and retry time. Provider cooldown defaults to five minutes; Retry-After is bounded to one minute–one day. Newly published empty rankings, unavailable charts and stale cache are different states.
- Publications over eight days old are labeled stale independently of the cache's last fetch time. “Provider update: not supplied” is intentional for Audius; fetch time is not presented as publication time.

## Local matching and explicit requests

Matching is server-side, indexed and bounded to 21 candidates per entry. Overfull identities stay ambiguous. Mint normalizes accents/punctuation without stripping live/remix/remaster/version qualifiers, compares artist/title, album and duration (2.5 seconds), and uses MusicBrainz recording IDs where available. Audius ISRCs are retained and used for MusicBrainz resolution; known conflicting recording identifiers are rejected. The existing Plex index does not contain an ISRC field, so local availability cannot claim ISRC verification where no recording ID exists.

Available songs use Plex-first artwork, native playback and the normal queue menu. Missing songs use neutral artwork and a muted treatment, not Apple preview art. **Play local songs** preserves chart rank order, reports skipped missing/uncertain entries and never starts acquisition.

Only an explicit approved-member **Add to library** action can submit acquisition. Mint resolves a signed, account-bound recording and reuses request ownership, advisory-lock deduplication, deterministic BullMQ job IDs, retry/cancellation and existing source selection. A selected recording is pinned through worker matching; Lidarr cannot silently fall back to another same-name recording. Automatic YouTube selection requires a unique artist/title/version/duration match; ambiguous sources need an explicit verified video link.

Missing recording metadata, incompatible versions or multiple local editions open a resolution flow rather than returning success. Check the recording's title, album and duration, optionally provide an HTTPS YouTube video URL, then request it. Some independent Audius uploads have no MusicBrainz recording or eligible configured source; acquisition may be unavailable. Follow **Settings & management → Activity & requests** for failures, source changes and retry/cancellation.

States are **available**, **missing**, **ambiguous**, **requested**, **processing** and **failed**. Visible pages poll availability every 15 seconds and also respond to existing realtime track events; completion becomes playable without reloading the document. Account-specific recording choices are private. Public visitors can see catalog availability and public artwork, but receive neither playback items nor acquisition privileges. No existing-library original is written, moved or deleted.

## API

Contracts live in `apps/web/src/lib/charts.ts`.

| Request | Response |
| --- | --- |
| `GET /api/charts` | `{ charts: ChartDefinition[] }` |
| `GET /api/charts?chart=apple-us&limit=25&offset=0` | `ChartPage`: provider/territory, period, checked/publication times, revision, cache state, notices, bounded ranked items and `nextOffset`. |
| `GET /api/charts?chart=apple-us&limit=25&offset=25&revision=…` | Next page. A changed ranking returns HTTP 409 instead of mixing chart revisions. Limit 1–25; offset 0–50. |
| `POST /api/charts/request` | Same-origin, approved-member JSON `{ chart, entry, token?, youtubeUrl? }`. Returns `available`, `requested`, or `resolve` with signed recording candidates. |

GET is rate-limited to 120 requests/minute per account/IP. Acquisition reuses the 30 requests/10 minutes account limit and one recording-catalog request/second instance limit. Errors are explicit JSON with appropriate HTTP status; cache and availability responses are private/no-store because member playback details differ from public responses. Provider credentials and the matching database never enter the frontend.

## Upgrading and validation

Update the pipeline worker before web. Migration **0012_charts** adds a normalized artist/title index and account-scoped chart links, reusing the existing recording-ID index; index creation can take time on a large library. It does not modify audio files, require a Plex claim, re-index the library or reset existing queues.

`tests/charts.test.ts` covers provider shapes, release-variant rank preservation, matching and cache failure states. `tests/charts-db.test.ts` uses `MUSIC_TEST_DATABASE_URL` and `CHART_TEST_REDIS_URL` for isolated PostgreSQL/Redis lifecycle checks; it creates and drops its own database. Worker tests cover recording pinning and source ambiguity.

For reproducible fictional screenshots, use a fresh, migrated local database named `mint_demo` or `mint_redesign_demo` and isolated localhost Redis. Run web at `127.0.0.1:3087` with `PUBLIC_URL=http://127.0.0.1:3087`, `PLAYBACK_WORKER_URL=http://127.0.0.1:3088`, `MINT_REDESIGN_FIXTURE=true`, and `NODE_OPTIONS=--import=<absolute-path>/apps/web/tests/fixtures/redesign-network.mjs`. Give the fixture process the same database, Redis and signing secret. Then run:

```bash
# Requires Playwright/Chromium and sharp available in the tooling environment.
# PLAYWRIGHT_MODULE may point to an externally installed playwright/index.mjs.
MINT_REDESIGN_FIXTURE=true npm exec -w @mint/web -- tsx tests/fixtures/redesign-preview.mjs
```

The fixture serves original generated artwork/audio, injects only fictional MusicBrainz metadata in the explicitly preloaded test transport, exercises the real signed web media gateway and queue submission, and simulates worker progress/completion. It does **not** prove a live third-party download, real Plex deployment connectivity or the unresolved desktop analysis-worker result-upload failure is fixed.
