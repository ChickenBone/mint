# Audio-copy operation and capability inventory (P0)

**Scope:** source-backed inventory of `ChickenBone/audio` at
[`5939dd3d31a9065e29f227bdd084a7023b1c3d67`](https://github.com/ChickenBone/audio/commit/5939dd3d31a9065e29f227bdd084a7023b1c3d67).
The GitHub commit endpoint resolved to that exact SHA; its tree SHA was
`83f4fbb3db7f83d7703a38bee89f80d23d3f31cc`. Source links below are immutable
links to that revision. This documents source and plan decisions, not runtime
behavior or production exposure. The separate user permission for source reuse
is recorded in [D31](../execution/decisions.md#decisions).

## Disposition key

- **Initial** means retain the capability in the combined initial API/SDK/web
  scope, rebuilding behind Mint-owned contracts. It does not promise wire
  compatibility with the donor app, donor implementation reuse, or Expo client
  integration.
- **Deferred** means preserve the capability/contract in the inventory but defer
  execution as the plan directs (remote workers).
- **Retired** means explicitly exclude a capability from target implementation.
- **Unresolved** means a required Mint-facing API contract is not established by
  the pinned donor source or remains implementation work; it does not mean the
  target disposition is undecided.
- The unexposed `operator-audit` internal contract is explicitly **retired**;
  this does not classify any mounted Audio-copy API operation as retired.

## Exposed server surface

The composition root mounts six tRPC namespaces at `/trpc`; authorization
procedures are guarded through the server context. Owners below are **proposed
Mint target owners** from the plan, not donor package ownership. `Listener API`
means the donor listener's handwritten client; target consumption is through
the typed SDK and existing Next.js UI as specified by the plan. The six mounted
routers expose 40 named query/mutation procedures in this inventory.

| Exposed capability / procedures | Evidence at pinned revision | Target owner | Consumers evidenced / planned | Disposition |
| --- | --- | --- | --- | --- |
| `catalog.search`, `catalog.discover`, `catalog.artist`, `catalog.album` | [`routers/index.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/routers/index.ts), [`catalog.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/routers/catalog.ts), [`catalog-browse.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/routers/catalog-browse.ts) | Catalog; Library supplies local availability/artwork edges | Listener API (`apps/listener/src/api.ts`); planned Next.js search/browse via SDK | Initial; preserve tolerant search, truthful catalog-unavailable state, bounded paging, and no browse-triggered acquisition per Mint policy. |
| `imports.status`, `imports.requestIntent` | [`imports.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/routers/imports.ts) | Acquisition | Listener API; planned SDK and Next.js request workflows | Initial; donor intent behavior is not authority to replace Mint's source-specific request/sync rules. |
| `library.session` | [`library.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/routers/library.ts) | Accounts | Listener API session validation | Initial; preserve revocation and active-account policy from Mint. |
| `library.list` | [`library.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/routers/library.ts) | Library | Listener library API and planned SDK/web library | Initial; optional read-only library import remains a target capability. |
| `library.savedSongs`, `library.like` | [`library.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/routers/library.ts) | Collections | Listener library API; planned SDK/web liked songs | Initial; Mint likes and occurrence semantics remain authoritative. |
| `library.lyrics` | [`library.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/routers/library.ts), [`lyrics.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/routers/lyrics.ts) | Playback | Listener lyrics API; planned SDK/web player | Initial; preserve Mint corrections, source provenance and timing preference. |
| `library.streamToken` | [`library.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/routers/library.ts) | Playback; Library owns file authority | Listener API stream/grant flow; planned SDK and media transport | Initial; Mint private grants, revocation, confined paths, Range/HEAD and codec behavior remain acceptance gates. |
| `recommendations.discovery` | [`recommendations.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/routers/recommendations.ts), [`music-discovery.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/routers/music-discovery.ts) | Collections; Catalog owns metadata inputs | Listener discovery API; planned SDK/web Discover | Initial; donor's separate optional public snapshot is not global chart coverage. |
| `recommendations.charts` | [`recommendations.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/routers/recommendations.ts) | Providers | Listener discovery API; planned SDK/web charts | Initial; provider scope/availability must remain explicit. |
| `recommendations.artistRadio`, `trackRadio`, `relatedArtists`, `newReleases`, `dailyMix` | [`recommendations.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/routers/recommendations.ts) | Collections; Catalog supplies graph/metadata | Listener discovery API; planned SDK/web discovery | Initial; retain Mint account likes/history/exclusions and measured-analysis inputs. Donor default daily-mix binding is cold-start, not parity. |
| `collections.saved`, `setSaved`, `playlists`, `playlist`, `createPlaylist`, `updatePlaylist`, `deletePlaylist`, `addItems`, `removeItem`, `reorder` | [`collections.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/routers/collections.ts) | Collections | Listener collections API; planned SDK and existing Next.js collection UI | Initial; preserve Mint occurrence IDs, revisions, source-managed imports, sharing and complete bounded traversal; donor detail caps are not target defaults. |
| `admin.configuration`, `listAccounts`, `createMemberAccount` | [`admin.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/routers/admin.ts) | Accounts | Donor admin API; planned Next.js admin through SDK | Initial; preserve approval, account isolation and separate admin policy. |
| `admin.overview` | [`admin.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/routers/admin.ts) | Platform and relevant domain status owners | Donor admin API; planned Next.js admin through SDK | Initial; status must come from durable domain/job state, not queue presence alone. |
| `admin.updateUserQuota` | [`admin-operations.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/routers/admin-operations.ts), [`admin.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/routers/admin.ts) | Accounts; Acquisition owns acquisition-specific limits | Donor admin API; planned Next.js admin through SDK | Initial; reconcile with Mint quota and source-admission rules. |
| `admin.inspectAttribution`, `resolveAttribution` | [`admin-operations.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/routers/admin-operations.ts) | Library and Catalog | Donor admin API; planned Next.js admin through SDK | Initial; keep uncertain/unmatched files playable and attribution evidence-backed. |
| `admin.queueDiagnostics`, `retryFailedJob`, `cleanDeadLetter`, `recoverStaleJobs` | [`admin.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/routers/admin.ts), [`queues.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/contracts/src/queues.ts) | Platform queue runtime plus owning domain (for example Acquisition) | Donor admin API; planned Next.js operator UI through SDK | Initial; retain operator recovery/inspection, redesigned around domain intent, receipts and fencing. |

The tRPC root and persisted-role checks are in [`routers/index.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/routers/index.ts)
and [`routers/context.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/routers/context.ts).
The donor listener calls the listed methods through
[`api.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/listener/src/api.ts),
[`collections-api.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/listener/src/collections-api.ts),
[`discovery-api.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/listener/src/discovery-api.ts),
[`library-api.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/listener/src/library-api.ts)
and the lyrics method in [`api.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/listener/src/api.ts).
The donor operator client is
[`apps/admin/src/api.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/admin/src/api.ts).
These are source-level consumers, not evidence that Mint's existing web UI
already calls these operations.

### Additional HTTP routes

| Route / methods | Source and owner | Consumer / disposition |
| --- | --- | --- |
| `POST /auth/login` | [`auth/http.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/auth/http.ts); Accounts | Listener and admin sign-in; **Initial**, rebuild under Mint session/revocation and rate-limit policy. |
| `GET /health`, `GET /live` | [`runtime/http.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/runtime/http.ts); Platform | Deployment/orchestrator health; **Initial**. |
| `GET`/`HEAD /artwork/:filename` (conditionally registered when artwork assets are bound) | [`runtime/http.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/runtime/http.ts), [`artwork-http.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/artwork-http.ts); Catalog/Library | Listener artwork; **Initial**, subject to Mint provenance, public/private separation and asset-rights review. |
| `GET`/`HEAD /stream/:recordingId` | [`runtime/http.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/runtime/http.ts), [`streaming/index.ts`](https://github.com/ChickenBone/audio/tree/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/streaming); Playback/Library | Listener playback; **Initial**, subject to Mint media authorization, Range/HEAD and codec acceptance gates. |

The tRPC plugin is mounted at `/trpc`; it authenticates a principal before
dispatch. The inspected runtime HTTP registration does not establish a
WebSocket/SSE delivery route. `events.ts` below defines job/event envelopes, not
proof of server-side fanout or replay. Mint's PostgreSQL-backed WebSocket and
recovery capability remains required by the plan; its target recovery contract
is a genuine implementation gap, not an undecided disposition.

## Reusable contracts exported by `@mint/contracts`

The [`contracts/src/index.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/contracts/src/index.ts)
barrel exports the modules below. Owners are target-domain recommendations;
consumers name source-level packages/clients where established. Unless otherwise
noted, these are **Initial** reusable contracts, to be revalidated and expanded
for Mint semantics rather than copied as-is.

| Contract capability | Pinned contract source | Target owner | Consumers / disposition |
| --- | --- | --- | --- |
| User, account, operator-account DTOs and account service ports | [`accounts.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/contracts/src/accounts.ts), [`app.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/contracts/src/app.ts) | Accounts; app DTO references also Catalog | Server auth/admin and listener/admin clients; **Initial**. |
| Artwork DTO, evidence/provenance, cache lookup/candidate/enrichment shapes | [`artwork.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/contracts/src/artwork.ts), [`artwork-cache.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/contracts/src/artwork-cache.ts) | Library and Catalog | Server artwork hydration/cache and listener; **Initial**, with asset rights and public/private cache policy still required. |
| Catalog identity, availability, provenance and search/browse page DTOs | [`catalog.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/contracts/src/catalog.ts), [`catalog-browse.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/contracts/src/catalog-browse.ts) | Catalog; Library for local availability | Catalog routers and listener browse/search; **Initial**, but improve continuation and completeness rather than inherit donor caps. |
| Provider chart entries and adapter port | [`charts.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/contracts/src/charts.ts) | Providers | Recommendations router and listener discovery; **Initial**, provider/scope availability explicit. |
| Saved-entity and playlist identities, paging and mutation DTOs | [`personal-library.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/contracts/src/personal-library.ts) | Collections | Collections router and listener collections API; **Initial**, preserve Mint occurrence/revision/source-managed semantics. |
| Import intent/state transitions, quota/result contracts | [`imports.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/contracts/src/imports.ts) | Acquisition | Imports router, listener request/status API and local workers; **Initial**, with Mint-specific explicit request and source-trigger policy. |
| Versioned job payloads and domain event envelopes | [`jobs.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/contracts/src/jobs.ts), [`events.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/contracts/src/events.ts) | Each owning domain; Platform owns delivery primitives | Server and local workers; **Initial** for local execution. **Deferred**: remote worker execution. These schemas do not establish durable event delivery, WebSocket fanout/replay, or a worker protocol suitable for remote execution. |
| Scanned-file, scan-batch, probe and attribution contracts | [`library.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/contracts/src/library.ts) | Library; Analysis owns independently versioned analysis results | Library scanner/probe/attribution and operator flows; **Initial** for optional read-only import. Donor scanned-original persistence and reconciliation gaps remain acceptance work. |
| Recommendation candidates/results | [`recommendations.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/contracts/src/recommendations.ts) | Collections; Catalog supplies metadata | Recommendation services/router and listener discovery; **Initial**, use Mint's real account/history/analysis inputs. |
| Queue states, diagnostics and recovery request/response shapes | [`queues.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/contracts/src/queues.ts) | Platform plus the domain owning each job | Admin operations and server queue services; **Initial**, with PostgreSQL intent/outbox/receipt/fencing requirements. |
| Stream/transcode target profile | [`web-target.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/contracts/src/web-target.ts) | Playback | Server media delivery and listener client; **Initial**, not proof that the disabled donor transcode binding supplies Mint compatibility. |
| Lyrics query, source and result statuses | [`lyrics.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/contracts/src/lyrics.ts) | Playback | Lyrics router/provider and listener lyrics API; **Initial**, preserve corrections and source/timing provenance. |
| Public discovery snapshot/readiness and refresh job shapes | [`music-discovery.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/contracts/src/music-discovery.ts) | Collections for listener discovery; Catalog for source metadata | Discovery router, worker and listener discovery API; **Initial** for scoped, honest discovery. It does not promise comprehensive charts or an invoked generic cold-start seed. |
| Admin quota and manual-attribution operation shapes | [`admin-operations.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/contracts/src/admin-operations.ts) | Accounts; Library/Catalog for attribution | Admin procedures and services; **Initial**, subject to the Mint policy and attribution evidence gates above. |
| Operator audit input/service interface (unexposed internal seam) | [`operator-audit.ts`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/contracts/src/operator-audit.ts) | None; no Mint target owner | **Retired/scrapped per user direction**: this unfinished donor-only contract is not in target implementation scope. At the pinned revision it is exported from the contract barrel, but no `operator-audit` procedure is mounted by `appRouter`, no API endpoint exists for it, and no client consumer is established by the router/client inventory. This retires only the unexposed internal seam; it does not retire a mounted procedure or imply a Mint audit capability. |

The job/event contract families do not amount to a WebSocket protocol. The
separate listener queue/progressive-playback, account history, offline,
devices/parties, measured analysis/DSP, and provider-sync APIs are Mint
capabilities covered by the combined P0 ledger; they are not established by the
donor router list above. The plan explicitly keeps remote execution deferred
and does not authorize retiring those Mint capabilities.

## License evidence and reuse boundary

| Evidence | Finding |
| --- | --- |
| Pinned repository tree | No root or nested `LICENSE`, `LICENCE`, or `COPYING` file was present in the recursive tree at the pinned commit. |
| GitHub repository metadata | The repository API returned `license: null` when checked. This is corroborating repository metadata, not a license grant. |
| Root and workspace manifests | Root [`package.json`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/package.json) and inspected local workspace manifests (`apps/server`, `packages/contracts`, `packages/db-core`, and `packages/domain-*`) declare packages `private: true` and no `license` field. `private: true` prevents publication; it is not permission to reuse. |
| Direct dependency metadata | At the lock-resolved versions, npm registry package metadata declares `@trpc/server@11.28.0` MIT, `fastify@5.12.8` MIT, `pg-boss@12.38.2` MIT, `zod@4.6.7` MIT, `pg@8.23.1` MIT, and `drizzle-orm@0.45.4` Apache-2.0. Versions are corroborated by the pinned [`pnpm-lock.yaml`](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/pnpm-lock.yaml); registry metadata is linked here: [tRPC](https://registry.npmjs.org/%40trpc%2Fserver/11.28.0), [Fastify](https://registry.npmjs.org/fastify/5.12.8), [pg-boss](https://registry.npmjs.org/pg-boss/12.38.2), [Zod](https://registry.npmjs.org/zod/4.6.7), [node-postgres](https://registry.npmjs.org/pg/8.23.1), [Drizzle ORM](https://registry.npmjs.org/drizzle-orm/0.45.4). |

**Conclusion:** a public license for the donor repository was **not established
by the inspected sources**. Separately, [D31](../execution/decisions.md#decisions)
records the user's assertion of ownership and explicit permission to reuse
Audio-copy source in this rewrite. It is not evidence of a public upstream
license or permission for third-party material. The direct package metadata
above is only a small license check, not a dependency audit; third-party and
transitive dependencies, optional/platform packages, notices, assets and runtime
tools actually selected still need version-specific review. No donor source was
copied and no dependency was added by this inventory.

## Validation and P0 status

- The requested SHA was resolved exactly; every donor source citation in this
  inventory points to that immutable revision, and the router/contract files
  cited were fetched from it.
- The tRPC procedure names are enumerated by namespace; each procedure group
  has an owner, consumer, source and disposition. Every exported contract
  family has a source and an explicit target disposition.
- License findings above are limited to repository tree/metadata, manifests and
  versioned package metadata; the separate user permission is recorded in D31.
- The [Mint inventory and explicit Audio-copy-to-Mint crosswalk](mint-operation-inventory.md#audio-copy-to-mint-capability-crosswalk-p0)
  now cover the route/action/event/worker surfaces and the capability mapping
  gap identified for P0. The coordinator accepted this inventory-and-crosswalk
  deliverable; this is not implementation of P1 or the application rewrite,
  nor completion of the remaining third-party review. The unexposed
  `operator-audit` seam is retired, not an unresolved API operation or a P1
  implementation requirement.
