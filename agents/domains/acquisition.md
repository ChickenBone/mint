# Acquisition pipeline (`acquisition`)

> Music requests, backlog, download/finalize jobs, Lidarr/TorBox/Prowlarr/Cobalt/MusicBrainz matching and pipeline stages.

## Boundaries

- Owns member requests (`lib/music-requests.ts`), backlog and downloads views, pipeline stages and track state, acquire/finalize jobs and acquisition services.
- Only explicit authorized member requests or explicitly enabled YouTube sync enter acquisition. Public visitors cannot request music.

## Invariants

- Originals are read-only. Confident upgrades are stored separately and verified by media inspection. A FLAC codec does not prove lossless provenance.
- Matching is conservative: artist, title, compatible album/version and duration. Ambiguous editions are never silently reused or replaced. A pinned recording carries through downstream matching.
- YouTube selection shares the audio-only policy in `@mint/core/matching`: artist-associated official audio, VEVO audio, Topic audio, then view-count-ranked eligible lyrics. Music videos are never a fallback, even when pinned or suggested by AI; missing source metadata needs review, not fabricated evidence.
- Clean YouTube imports stay pinned without search; unsafe imports retain an atomic original-ID alias and re-match clean audio in acquisition, without trusting the imported duration. Exact source collisions merge references, never fuzzy recordings. Data API sync re-matches have a bounded Pacific-day Redis search budget and shared exhaustion cooldown. Explicit pasted pins are never substituted. Legacy pending music-video pins need review; acquired files remain untouched.
- Public-page source metadata is opt-in only after the operator obtains written YouTube permission. Matching and pin/claim checks use the same bounded server-only adapter, approved-member checks and shared Redis throttling; they do not fall back to the Data API, send account credentials, cache page/stream data or bypass access refusals. Personal likes and playlist sync still use the Data API.
- Requests are signed, account-bound, deduplicated and use the existing job lifecycle. If identity or source is insufficient, expose a resolution flow instead of success-shaped queueing.
- Worker source-selection warnings include bounded per-candidate kind, duration, validated views and rejection evidence plus search-round counts; aggregate user errors alone cannot establish an incident's cause. Keep descriptions, credentials and media URLs out of this trace.
- Ambiguous imports may carry exact-identity official non-video catalog lengths in acquisition job state, including studio recordings on compilations but not other secondary release types. Reject catalog video flags and incompatible disambiguation versions. Require every source to match one when supplied; Topic and lyric sources need catalog duration evidence. Persist the selected supporting length before pin/claim checks, without pinning an arbitrary ambiguous recording ID.
- Later provider failures retain already-eligible candidate evidence with degradation logging; without that evidence, quota/transient errors stay retryable. Catalog outages may use independently sufficient official/VEVO audio, never fabricated Topic/lyric duration evidence. Refused authorization and explicit pin safety are not bypassed.
- YouTube audio-source selection alone may ignore standalone remaster labels when duration evidence exists, and may accept unlabelled artist-channel uploads only with an exact (2.5-second) expected-duration match, non-VEVO channel and no teaser/live/session/full-album terms; they rank last and are never clean sync imports. Catalog/chart/library matching still preserves remaster qualifiers. A credit-free fourth search round runs only when nothing is eligible. `npm run -w @mint/worker match-report -- <worker.log>` tallies closest rejection reasons.
- Reviewable-but-unproven candidates become `sourceChoices` and fail with detail "Needs a source"; members pick only from that list (`apps/web/src/lib/track-sources.ts`, `/api/music/sources/:id`). "Wrong audio" appends the current video to `blockedVideoIds`, which automatic selection must never pick. Downloaded files are length-checked before finalizing.
- `audio-regression.test.ts` replays captured listings from `fixtures/audio-regression.json` through the real scraper/policy offline; fix regressions with general policy changes, never per-song rules. Recapture sparingly with the paced capture CLI.
- Keep requested, processing, failed and ambiguous states distinct and observable with retry. Do not advertise broken indexers as configured.
- Do not bypass CAPTCHAs or entitlements. Support only acquisition the operator is authorized to perform.
- Add-only integration wiring never overwrites operator settings.

Details: [integrations and charts](../integrations-and-charts.md).

## Entry points and gotchas

- Flow: request (`lib/music-requests.ts`) → `jobs/acquire.ts` → services → `jobs/finalize.ts`. `track-state.ts` updates stages and emits public-safe events (`realtime`).
- `core/src/stages.ts` defines the stage vocabulary shared with UI badges and the pipeline board.
- `integrations.ts` handles zero-config wiring for bundled Plex and Lidarr at worker startup.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Music requests, backlog, download/finalize jobs, Lidarr/TorBox/Prowlarr/Cobalt/MusicBrainz matching and pipeline stages.
- **Read before editing:** [agents/integrations-and-charts.md](../integrations-and-charts.md), [agents/architecture.md](../architecture.md) (UI: also check desktop/mobile per DESIGN.md).
- **Imports from:** [`collections`](collections.md), [`library`](library.md), [`platform`](platform.md), [`playback`](playback.md), [`providers`](providers.md), [`realtime`](realtime.md), [`web-shell`](web-shell.md)
- **Imported by:** [`analysis`](analysis.md), [`collections`](collections.md), [`library`](library.md), [`platform`](platform.md), [`providers`](providers.md), [`realtime`](realtime.md), [`web-shell`](web-shell.md), [`workers`](workers.md)
- **Live detail:** `npm run agents -- map acquisition` (exports, line counts, cross-domain import edges).

### Owned files (43)

- `apps/web/src/app/app/` `downloads/page.tsx`, `jobs/page.tsx`
- `apps/web/src/components/` `pipeline-board.tsx`, `stage-badge.tsx`
- `apps/web/src/components/app/` `downloads.tsx`, `retry-button.tsx`, `track-source-actions.tsx`
- `apps/web/src/lib/` `backlog.ts`, `music-requests.ts`, `track-sources.ts`
- `apps/web/tests/` `backlog.test.ts`, `music-requests.test.ts`
- `apps/worker/src/` `audio-regression-capture.ts`, `audio-regression.test.ts`, `audio-regression.ts`, `existing-track.ts`, `integrations.ts`, `match-report.ts`, `media.ts`, `music-requests.test.ts`, `parse.test.ts`, `parse.ts`, `track-state.ts`
- `apps/worker/src/fixtures/` `audio-regression.json`
- `apps/worker/src/jobs/` `acquire.ts`, `finalize.ts`, `media.integration.test.ts`, `search-request-enrichment.ts`, `torbox-bridge.integration.test.ts`, `torbox-bridge.ts`
- `apps/worker/src/services/` `cobalt.ts`, `lidarr.ts`, `matching-classifier.ts`, `musicbrainz.ts`, `prowlarr.test.ts`, `prowlarr.ts`, `torbox.test.ts`, `torbox.ts`
- `packages/core/migrations/` `0002_drop_previews.sql`
- `packages/core/src/` `stages.ts`, `track-state.ts`, `youtube-scrape.test.ts`, `youtube-scrape.ts`

### Validate

Owned tests: 10.

```bash
npm run typecheck -w @mint/web
npm run lint -w @mint/web
npm exec -w @mint/web -- tsx --test --test-force-exit tests/backlog.test.ts tests/music-requests.test.ts
npm run typecheck -w @mint/worker
npm exec -w @mint/worker -- tsx --test --test-force-exit src/audio-regression.test.ts src/jobs/media.integration.test.ts src/jobs/torbox-bridge.integration.test.ts src/music-requests.test.ts src/parse.test.ts src/services/prowlarr.test.ts src/services/torbox.test.ts
npm run typecheck -w @mint/core
npm exec -w @mint/core -- tsx --test src/youtube-scrape.test.ts
```

> Integration/DB tests skip without PostgreSQL/Redis/audio env vars; see `.github/workflows/ci.yml`. A skip is not a pass.
> Changing owned `packages/*` files affects every consumer: run root `npm run typecheck` (`npm run agents -- affected` does this automatically).
> If you change the schema, add a new migration via `npm run db:generate`; never rewrite applied migrations.

<!-- agents:generated:end -->
