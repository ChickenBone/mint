# Seeding, discovery and crawling

## Separate the mechanisms

| Mechanism | Meaning | Safety boundary |
| --- | --- | --- |
| Metadata seeding | Populate known artists, releases, recordings and provider charts | Metadata does not create playable files, ownership or acquisition jobs |
| Local library import | Associate already-owned media with identity and availability | Original music remains read-only; uncertain matches stay uncertain |
| Provider playlist import | Preserve account/source-managed collections and aliases | Do not silently delete source data or claim provider-managed items are editable |
| Crawling/enrichment | Expand permitted metadata coverage in background | Source terms, rate/deadline budgets, provenance and resumable work |
| Listener discovery | Rank available music and display honest missing metadata | Browse/play-local never acquires missing music |
| Acquisition | Explicit identified recording/source choice and authorized processing | Separate command, ownership, deduplication, matching and observability |

## Three different surfaces

Mint's Next.js listener/backend discovery is **not** its crawler.
`services/catalog` is an independent Python/PostgreSQL/Qdrant metadata engine
with bulk loading, automatic seeds, demand, fair scheduling and index revisions.
Keep these strengths when rebuilding in Audio-copy-shaped packages; language or
service consolidation is now selected for the TypeScript/PostgreSQL/pgvector
target, not permission to discard these capabilities or deploy an
overlapping authoritative catalog.

Mint's listener separately uses actual account likes/history/exclusions for
mixes/radio/rediscovery and measured analysis for sonic selection. Native Home
wires for-you/recent/rediscover plus a bounded album shelf. Recent means track
creation time, not chart publication. These are bounded heuristics, not ML or
global listening evidence. See [M10-M16 in the ledger](baselines.md).

Audio-copy's generic cold-start helper is not invoked and chart providers are
empty in default composition. Optional public discovery is separately active.
See [A6-A9 in the ledger](baselines.md): exported helpers and queue registration
are not evidence of active automatic bootstrap.

| Question | Mint baseline | Audio-copy baseline | Target recommendation |
| --- | --- | --- | --- |
| How are local files admitted? | Plex-backed read-only indexing | Root checkpoints, whole-root relist per batch; completed roots do not reset, technical probe persistence incomplete | Replace Plex with recurring generations/incremental inventory, persisted probes and rename/deletion/mount-loss-safe freshness |
| What seeds the catalog? | Enabled source seeds run automatically; MusicBrainz/ListenBrainz default on, YT/YTM off and public adapters unconfigured | Generic seed helper uninvoked; empty chart providers; separately active optional public discovery | Retain/reimplement Mint's bulk/seed machinery; improve donor gaps rather than copy them |
| What drives crawl priority? | Demand boosts plus baseline priority, rotating lanes, host admission, popularity and library artist priorities | `exploreDiscovered=true` bypasses popularity/demand eligibility; bounded per-operation exploration | Preserve fairness and separately budget demand versus bulk/exploration |
| How does personal discovery work? | Actual account likes/history/exclusions, bounded candidate sets and analysis | Default daily-mix binding cold-start | Retain real history integration; adapt graph ranking without replacing it with cold-start |
| Does browse download? | Product policy: no | Metadata pipelines do not; explicit Play/Like intents can acquire | Keep metadata independent and Mint's explicit identified-recording choice policy |

## Audio-copy capability status

| Capability | Status in inspected binding | Target treatment |
| --- | --- | --- |
| Local-first search and normalized miss outbox | Default active; quotas, deduplication and once-per-second dispatch | Adapt durable demand; improve complete paging and batched availability/favorites |
| Generic cold-start seed | Helper/worker exists but no production caller; default chart providers empty | Implement explicit boot-seed coverage manifest and supported source list |
| Optional YouTube Music public discovery | Opt-in active worker/snapshot; new albums and weekly official music-video ranks | Adapt stale/unavailable UI; preserve exact scope, not global charts |
| Public adapter artist coverage | Header only; not releases/graph | Complete provider contract/pagination deliberately, not by UI scrolling tests |
| Persistent outward graph | Default bounded depth 2/nodes 25, operation checkpoints/leases | Retain fencing; add real demand/library interest and independent exploration limits |
| Popularity-only crawl policy | Bypassed in actual default; no bound popularity/demand input | Improve rather than copy helper semantics |
| Bulk archives/COPY and vectors | No implemented ingestion/vector query pipeline; extension installation is infrastructure only | Preserve/reimplement Mint capability; metadata vectors remain separate from audio analysis |
| Refresh/retraction/completeness | Operation hashes lack refresh TTL/epoch; historical complete/skipped clears pending; detail caps 100 | Add refresh versions, source retractions/tombstones, coverage status and continuation |
| Source throttling | Distributed permits exist, but AbortSignal dropped and separate raw discovery governor | Abort-aware contract plus shared total upstream/fairness budget |

## Mint mechanisms worth preserving

| Mechanism | Implemented detail | Limit / rewrite improvement |
| --- | --- | --- |
| Automatic seed jobs | `seed()` is called from crawler `run()`; enabled Apple countries, ListenBrainz, YTM charts, explicit YT channels and configured public adapters | Code defaults are not deployment configuration; source flags, countries and coverage must remain explicit |
| Bulk ingest | Fingerprinted advisory-lock MusicBrainz/OMDB runs; observations/entities/relationships and cursor committed together; batched COPY staging, no per-record online lookup flood | MusicBrainz archive/genre attribution matters; OMDB parses dumps, not executable SQL restoration |
| Discogs import | Safe defused XML, bounded batches, idempotent writes | No persisted resume cursor; restarts replay from beginning, unlike MusicBrainz/OMDB |
| Fair crawl/admission | Deterministic source-scoped lookup/search/page keys, shared host admission and `SKIP LOCKED` leases; five-slot per-host cycle: one oldest-due, three bulk-expansion-priority and one general-priority slot, with empty bulk slots falling back | Bounded MusicBrainz browse/release expansion is not exhaustive crawling |
| Fencing and completion | Reclaimed/expired leases cannot publish; completion clears demand boost separately from baseline priority | Test crash and lease takeover explicitly before reuse |
| Popularity | Observed chart/count signals decay weekly, propagate along real edges; keyset sweeps and verified library artist bonus | Not universal streams or personalized popularity; retain provenance |
| Search/index | Lexical/vector fusion over bounded candidates; revision checks; PostgreSQL authoritative and Qdrant derived | Search `has_more` lacks continuation cursor; metadata vectors are not audio embeddings |
| Demand | Token-bound anonymous bridge, bounded signals/exact candidates, metadata job priority only | Client batches are process-local/best-effort and may be lost at exit/network failure |
| Index recovery | Revision-fenced Qdrant upsert then indexed-revision/outbox commit | External write holds database transaction/budget; benchmark contention and idempotent retry |

## Required rewrite contracts

Keep raw source records and provenance distinct from reconciled recording
identity, local-media links and account state. Different provider IDs and equal
names are not evidence of identical editions. Store match confidence/reasons;
support ambiguous, unavailable and no-match separately.

Define independent queues/budgets for seed ingestion, demand enrichment, crawler
expansion, snapshots and acquisition. Retries need deduplication, cursor/checkpoint
state, retry classification, lease ownership and recovery after process failure.
A database outbox plus reconciler is recommended; no existing implementation is
claimed for Mint demand or either acquisition command boundary. Audio-copy's
search-miss outbox is an implemented pattern, distinct from its non-atomic
acquisition admission/enqueue.

The target needs a **boot-seed coverage manifest**: source/default/opt-in status,
chunk boundaries, input fingerprint, checkpoint/replay policy, attribution,
capacity, expected coverage and completion evidence. Combine resumable bulk
ingest with durable anonymous demand events, source-aware retry/next-attempt
budgets and starvation limits. Include freshness/retraction/canonical merge/split
contracts, not just initial entity inserts.

Operators need source/scope/freshness, backlog, attempts, cooldown and recovery
controls without exposing credentials or private search/history in public output.
An optional unavailable catalog must not break existing-library search/playback.
Never label sampled or provider-scoped rankings as a worldwide comprehensive chart.

## Acceptance evidence

Use controlled provider fixtures and disposable databases to verify resumed
seeding without duplicates, bounded fan-out, cooldown/retry, source outage and
explicit freshness. Verify malformed/ambiguous matches do not create tracks or
download work. Test browse/search/play-local with acquisition counters held at
zero; separately test an explicit recording choice and duplicate concurrent
requests. Benchmark bounded queries and full-selection playback independently
from visible-page size. Live-source checks require separate authorization and
terms review; fixtures do not establish permission or live completeness.
