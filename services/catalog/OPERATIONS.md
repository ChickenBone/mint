# Catalog operations reference

For local startup and the live dashboard, use [README.md](README.md).

Independent multi-source aggregation and search for a future Mint consumer.
Nothing imports Mint packages, connects to Mint databases, modifies its API or
starts with its main Compose stack. Build context, dependencies, databases and
volumes are confined to this directory/project.

## Sources and coverage

| Source | No-key input | Purpose and limits |
| --- | --- | --- |
| MusicBrainz | Public artist, recording and release-group lookups, including explicit genres; paginated artist recordings/release groups and bounded release recordings | Open identity and metadata; recordings and release groups are not individual release editions. Shared rate limit: at most one request/second. Supply an identifying application/contact User-Agent. |
| ListenBrainz | Public **sitewide weekly** top recordings | Popularity seeds linked by explicit recording/artist MBIDs. Community sample, not worldwide listening counts. Entries without recording MBIDs are not guessed. |
| Apple, opt-in | Public top-song chart feeds and iTunes lookup endpoint | Storefront-specific chart seeds and artist/album/song expansion. Default shared lookup budget: 15 requests/minute. Lookup caps do not support exhaustive catalog enumeration. |
| YouTube | Public channel Atom feeds and video oEmbed metadata | Explicit channel/video seeds; recent uploads, titles and available public view observations. Channel uploader identities are not verified musical artist identities. |
| YouTube Music | Unauthenticated `ytmusicapi` charts, artists, albums, songs and bounded chart playlists | Country chart seeds expand through explicit browse/video IDs. Unofficial access can change or fail; no credentials, account access or challenge bypass. Unranked chart entries remain unranked. |
| Spotify / SoundCloud | Public oEmbed lookups for explicitly seeded IDs/slugs | Limited metadata, not public catalog/chart/search APIs. No token/client-ID extraction. |
| Deezer | Public charts and artist/album/track metadata | Explicit positions only; artist albums and album tracks paginate with a 10,000-offset cap. |
| Audius | Public trending/user/track metadata | Raw plays, bounded user-track pagination to 10,000-offset cap; attribution links use the stable metadata endpoint rather than invented UI routes. |
| Internet Archive | Live Music Archive top-download search and projected item metadata | Item is a live set/album; downloads are item-scoped. No media manifest or files downloaded. |
| Wikidata | Explicit Q-ID metadata and asserted provider IDs | Caller supplies kind; no name matching. Labels prefer English, then multilingual, then a deterministic available language; `label_language` preserves provenance. Amazon ASINs remain product links, never fake Amazon Music API results. |
| Openverse | Music-only metadata feed and item lookup | Requires stored license URL, attribution and source landing-page link. No audio or embed HTML retained. |
| Discogs | Public artist/master/release metadata, paginated artist releases; local CC0 XML dumps | Artist IDs numeric, albums prefixed `m`/`r` to separate masters/editions. Explicit genres/credits, separate styles, scoped release `have`/`want` counts. Minimum 2.5s/request; no authenticated search or tracklist-derived song IDs. |
| Openwhyd | Public current hot-track export, at most 20 results | Discovery-only: stores explicit YouTube/SoundCloud identities, with posts/reposts/likes when present. Minimum 2s/request. No user metadata, comments, media URLs, inferred genres or historical coverage claim. |

See [SOURCES.md](SOURCES.md) for 27 researched options and source references.
Nine additional adapters are opt-in through `PUBLIC_SOURCES`; existing `.env`
files retain their previous configuration. Spotify, SoundCloud and Wikidata need
explicit seeds or supported crosswalks; they do not have automatic chart feeds.
New public adapters reject redirects, use fixed HTTPS endpoints and share the
persisted host request budget. A pagination cap fails visibly rather than
claiming an exhaustive discography.

No browser token extraction, authenticated account access, rotating
proxies, challenge solving, audio, previews, lyrics or artwork downloads.
Only compact metadata, explicit relationships, attribution URLs and derived
search vectors are stored. Adding another source requires its own parser,
identity namespace, public access policy and rate budget; do not silently
substitute a different provider when one fails.

Genre coverage depends on the provider and record type. MusicBrainz lookups
request public `inc=genres` on the existing request, not arbitrary tags or
authenticated user genres. Apple supplies explicit genre labels; Deezer's full
album payloads can supply genres, while tracks and artists generally do not.
Audius songs and Openverse records retain their explicit genres. Missing genres
remain missing: album or artist genres are not silently copied onto songs, and
YouTube categories or oEmbed titles are not interpreted as musical genres.
Partial catalog pages can lack tags until their full lookups run.
Updating the parser does not instantly retag existing records: their scheduled
lookups must run, or an operator can seed a specific ID through the console/CLI.

Sources and permissions:
[MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API),
[rate policy](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting),
[data licenses](https://musicbrainz.org/doc/About/Data_License),
[ListenBrainz API](https://listenbrainz.readthedocs.io/en/latest/users/api/statistics.html),
[Apple Search API](https://performance-partners.apple.com/search-api),
[Apple site terms](https://www.apple.com/legal/internet-services/terms/site.html).
Review current terms for the intended storage/redistribution and preserve
attribution. No-key access is not permission for unrestricted catalog mirroring.
Apple is disabled by default; enabling it is an operator decision about permitted
use, not a way around its access or reuse restrictions.
Apple lookup responses may label JSON as `text/javascript`; this MIME type is
accepted only on the iTunes lookup host and still requires a valid JSON object.
HTML and JSONP responses remain errors.

YouTube Music uses its unofficial web-client protocol through a pinned
`ytmusicapi` dependency. It is not Google's supported Data API and has no stability
guarantee. Every underlying request shares the persisted host budget; each job
has request, elapsed-time and response-byte caps. Review
[YouTube's terms](https://www.youtube.com/static?template=terms) and
[ytmusicapi documentation](https://ytmusicapi.readthedocs.io/) for your intended
use. No login, age restriction or consent challenge is worked around.

YouTube channel feeds need explicit `UC...` channel IDs in `YOUTUBE_CHANNELS` or
console/CLI seeds. They contain only recent uploads, not full channel histories.
Feed view counts, when present, contribute `log(1+views)/20` as a decaying scoped
signal; source detail preserves the raw observation and `signal_kind=views`.
Video records are indexed as `song` for shared retrieval, **not** certified
recordings. No title-based merge with MusicBrainz or Apple is performed.

YouTube Music chart jobs seed returned artist/album IDs and the first ten video
chart playlists. Each playlist is bounded to 100 tracks; artist sections to 100
entries each and album tracks to 200. Artist discovery includes public
music videos. Uploaders without a music-artist header use the library's
public channel parser, never an authenticated user/account endpoint.
Browse ID types determine whether a returned chart item is an album or artist,
even when an upstream library shelf label is incorrect. No full-catalog or full-discography claim
is made. Explicit chart ranks contribute the normal rank signal; playlist order
and unranked artist order do not.

## Live console

The search service serves `/`, static local assets and an operator console.
`/v1/console/live` is a same-origin WebSocket with five-second database snapshots;
clients share a process-local five-second cache, with at most eight live streams.
The map defaults to **Embedding Atlas**, Apple's MIT-licensed WebGPU component,
bundled locally at version 0.26.0. No CDN, remote embedding service or API key
is involved. It requires WebGPU with `shader-f16`, available only in compatible
browsers over HTTPS or localhost. An unsupported renderer fails visibly and
leaves the record picker and relationship modes available. Existing script
and style CSP remain unchanged; automatic cluster labels are disabled.

`GET /v1/console/embedding-map` scrolls the configured Qdrant collection in
2,048-vector pages. Optional `source`/`kind` filters are cursor-scoped. The
deterministic point ID and vector revision must match PostgreSQL's current
`revision=indexed_revision`; stale, deleted or inconsistent payload rows are
omitted. Each SQL statement has a two-second budget; two map reads may run
concurrently. Initial coordinates use a deterministic, bounded power-iteration
approximation to two-component PCA fitted on the first nonempty current-vector
page, not the entire catalog. The fit size and retained **sample** variance
are displayed. Later pages share that basis; positions remain stable while
loading. Projection sessions are process-local, expire after 30 minutes and
retain at most 32 bases. An expired/evicted cursor returns 409 and requires
Reload projection. Reloading can change positions as data changes.

The initial map is a partial page. **Load more vectors** adds a page;
**Load indexed catalog** streams until the collection ends, the operator stops,
a dependency fails or the browser's explicit 1,000,000-point limit is reached.
Automatic loading updates the GPU/picker at geometrically increasing batches
rather than rebuilding a million points on every page. Displayed and loaded
counts remain separate. This is a live keyset scan, not a frozen export:
concurrent inserts before the cursor require a later reload. No five-second
telemetry or 30-second graph timer rescans/reprojects the vectors.
Missing/pending embeddings and genre-only hubs have no embedding-map point.
Genre evidence remains available in the source inspector and graph views.
Embedding proximity is lossy metadata similarity, not audio similarity,
verified identity, musical clustering or a stored relationship.

Rebuild browser assets with `npm ci && npm run build:atlas` in this directory.
The pinned npm lock, official component entry, build script, Apple MIT license
and bundled Svelte notice are retained. The Python image copies the generated
static assets and needs no Node runtime. Upgrading just `search` publishes the
console without restarting the crawler, indexer or bulk importer.

**Whole catalog groups** remains a complete grouped overview rather than
a recent sample or an unbounded load of raw browser nodes. Provider/type groups
count every stored record; a genre group covers every distinct normalized tag.
Aggregate edges count actual stored relationships and record–tag memberships.
Select or zoom into a group to refine it, and use breadcrumbs to navigate back.
Large groups split by successive MD5 key digits (storage partitions, not musical
similarity); terminal branches show at most 80 records plus connected provider/type
context groups. No records are discarded at the record explorer's 180-node limit.

**Record explorer** shows artists, songs, albums and genre-tag hubs connected
by stored artist credits, album membership and explicit tags.
Root pages independently keyset-page each record kind (10 per kind by default);
search matches stored names and tags. Selecting a record or genre expands its
neighborhood, with 60 neighbors per page, at most 150 stored records and 180
total nodes/400 links. Tags normalize whitespace/case only, never infer genres.
Artist connections mode projects canonical artists through shared stored
recording/album credits, preserving attributed evidence across verified aliases.
Recent records mode retains the last 60 changed records plus fetched neighbors
and up to 160 edges; selecting a record loads at most 100 direct relationships.
Relationship modes do not load unbounded raw nodes; Embedding Atlas progressively
loads indexed points within the stated browser limit. Queue/worker/source/error views are bounded.
Topology uses bounded library layouts of evidenced fetched links;
unlinked records are not given fabricated edges. Hover/focus highlights direct
neighbors. Drag to pan, zoom, Fit to return to the recent sample, or Expand.
The record picker and connection-evidence buttons provide non-pointer selection
alternatives. Whole-catalog and record overviews refresh every 30 seconds while visible and
unpaused; selected/expanded neighborhoods stay stable until an operator
navigates. Recent records and telemetry continue using five-second snapshots.
Snapshots have a two-second SQL statement budget; failures remain visible and
the UI shows stale connection state instead of fabricated progress.

The graph occupies the full content width. Node spacing defaults to 1.8× and
is adjustable from 1× to 3×; unlinked overview partitions use a grid rather than
an excessively tall force layout. Sources/workers, live activity, pipeline detail,
instructions and selection evidence unfold below the primary graph; no controls
or source attribution are removed. A canvas-independent record/group picker
provides the same drilldown, including when the renderer fails.

The top strip reports actual PostgreSQL storage, records, current vectors,
queue state, observations from retained events in the last five minutes and
dead letters. Observations are not unique newly inserted records. **Storage
breakdown** shows catalog table bytes (including TOAST), SQL index bytes and
queue bytes; queues are already included in tables/indexes. Values use decimal
GB (1,000,000,000 bytes), retaining exact bytes in tooltips.
`GET /v1/console/storage` reads `pg_database_size`, `pg_table_size`,
`pg_indexes_size` and `pg_total_relation_size` in a read-only transaction,
cached for 30 seconds per search process. Total database bytes also include
system catalogs; table/index breakdown covers public catalog tables only.
WAL, backups, free disk and other containers are excluded. Qdrant's collection API
does not report disk usage; `qdrant.disk_bytes=null` and an explanatory note are
returned rather than a guessed size. Storage has no Qdrant dependency. Its
failure is visible separately without breaking live telemetry or the graph.

Entity and indexed counters are persisted transactionally. Worker state uses
actual heartbeats (stale after 120 seconds), not Docker CPU/memory estimates.
The console does not mount a Docker socket or expose raw container logs.
Read service logs with `docker compose logs -f`. Events retain the most recent
2,000 entries. The dashboard displays the latest 60.

Controls queue explicit provider IDs, pause/resume source claims and retry one
job. Pausing does not cancel in-flight work, remove records or override `.env`
enable flags. Resume does not bypass host backoff. Controls require an automatic
per-process same-origin token; hostile Origin/Host requests are rejected. This
is CSRF protection for a loopback operator tool, **not user authentication**.
Do not expose it publicly. Remote operators should use a local tunnel rather
than publishing the console to a LAN. Use one search replica as configured.

Schema v8 migrates standalone v1/v2/v3/v4/v5/v6/v7 databases automatically during `initialize`,
preserving metadata, queues, counters and pauses, and adding source-host jobs,
provider links, attribution annotations, reversible artist identity groups and
per-host dispatch cursors/indexes, source contracts, import checkpoints and indexed
recording-provider link lookups. Back up
before upgrading. Rebuild with `docker compose up --build -d`.

## Large database imports

The crawler enriches/follows live sources; bulk snapshots populate millions of
records without millions of HTTP requests. All ingestion uses bounded PostgreSQL
`COPY` staging and set-based entity/counter/edge/outbox updates. A transaction
accepts at most 4,096 observations; the large snapshot readers flush at 2,048.
Quality protection, global capacity admission and revision-fenced embeddings
remain authoritative. Duplicate keys select the highest-quality observation,
with the last observation winning ties. Unchanged credits/job priorities are not
rewritten. No SQL durability, index, lease or source policy is disabled for speed.

`MAX_ENTITIES` accepts 100–1,000,000,000 source-scoped records; the default remains
10,000,000. Raise the configured capacity deliberately for a full MusicBrainz
or OMDB import. Capacity is not preallocated storage and does not guarantee that
the host has enough disk. Include dumps, metadata, WAL, SQL indexes, backups,
384-dimensional vectors and graph indexes in disk planning. Docker database
volumes are separate from the host download directory.

The `bulk` Compose profile runs `load-musicbrainz /imports` as a separate optional
service. It downloads only official MusicBrainz JSON snapshots, resumes `.part`
files using HTTP byte ranges and checks published SHA-256 before atomic rename.
Existing mismatched files are retained and fail visibly; no data is silently
deleted or accepted. The initial snapshot is selected via `LATEST`, or pinned by
`MUSICBRAINZ_SNAPSHOT`. Restart the service only against the intended snapshot;
changing `LATEST` can select a newer, distinct import.

The service's default nonroot UID/GID is 10001. Its mounted download directory
must be writable by that user; read-only manual imports require readable files
only. `docker compose stop bulk-import` stops the loader without stopping
crawling/search. SIGTERM drains a batch and saves its cursor. `docker compose
--profile bulk up -d bulk-import` resumes it. Automatic retries are limited to
five; permanent parse/capacity/checksum failures remain failures.

`import-musicbrainz PATH --kind artist|release-group|recording|release`
also accepts raw JSONL, JSONL.gz or JSONL.xz. Releases contribute their embedded
recording MBIDs and release-group album memberships, not fictional track IDs.
Repeated recording memberships across releases are unioned. The recording dump
alone is not the full recording catalog. Genre metadata retains its separate
CC BY-NC-SA 3.0 attribution; aliases, biographies, ratings and arbitrary tags
are not imported.

Dump inputs have a separate 10,000-genre input budget: the searchable entity
retains at most 20 genres as before, while larger explicit lists remain in
attribution annotations with `genre_count`, `genres_truncated` and `all_genres`.
This handles richly tagged dump artists without changing live-API response
budgets or silently losing the overflow. Newly imported recordings also retain
their length and supported explicit recording-provider URL relations for
reconciliation; these do not schedule HTTP enrichment jobs.
Snapshot titles/combined artist credits accept up to 65,536 characters and
10,000 credit entries, separately from the unchanged live API budgets. Long
source names are retained, not shortened or replaced with invented labels.

`import-omdb PATH --kind KIND` reads the OMDB PostgreSQL tar/custom format through
`pg_restore` **to a pipe only**. Downloaded SQL, DDL, triggers and functions are
never executed or restored into the catalog. Only documented metadata tables
are selected. Run `artist`, `album`, `song`, then `album-artists`, `song-artists`,
`song-features`; a relationship whose source is absent fails instead of being
silently lost. The service image includes PostgreSQL client tools. OMDB keeps
its own namespace, research-use notice and actual aggregate counts. Playback
tables, image fields, media URLs and lyrics-service IDs are discarded. There
is no automatic OMDB downloader because its published downloads are unavailable
(lite link expired; full link removed).

Both readers SHA-256 fingerprint their input, take a per-snapshot import lock and
atomically save progress alongside each committed metadata/edge batch in
`import_runs` (visible in Data browser). Rerunning the same file/kind resumes;
completed inputs are no-ops. `--limit` bounds **new input records for that run**,
not total catalog size. MusicBrainz defaults to 100,000,000 input records per
run; OMDB to 1,000,000,000. Compressed/archive resumption rereads/decompresses to
the cursor but does not rewrite preceding records. A single large source record
can span transactions; interruption replays its unfinished portion idempotently.
The observation counter can therefore include reobservations, not just inserts.

Inputs retain byte/nesting/list budgets: at most 64 MiB per JSON/COPY line and
2 TiB decompressed data per reader. Snapshot downloads allow up to 128 GiB per
compressed archive and retain a 1 GiB free-space reserve. These bounds prevent
unbounded allocation, not complete-provider coverage guarantees. Invalid records
fail with their input ordinal; earlier committed batches and cursors survive.

Keyword search sees committed metadata before embeddings finish. The vector
outbox may grow substantially during imports; its size is lag, not lost data.
Increase `INDEX_BATCH_SIZE` up to 256 and tune existing indexer workers/threads
against measured CPU/RAM. More indexer models consume more RAM; never report
the metadata import rate as an embedding or upstream crawl rate.

## Discogs bulk import

The explicit `mint-catalog import-discogs PATH --kind artist|master|release`
command reads a local CC0 XML or XML.gz dump; it never downloads one itself.
See [startup examples](README.md#bulk-metadata-without-per-record-http).
Labels, audio, images, user biographies and positional tracklist IDs are not imported.
Masters and release editions stay separate albums. Only explicit genres become
genre tags; styles and CC0 provenance remain in attribution annotations.

Imports stream and discard processed XML records, writing 128 observations per
transaction through normal entity counters, relationships and vector outbox.
They do **not** schedule online lookups or artist-discography expansions, even
when the Discogs network adapter is enabled. Indexers keep processing the outbox.
Use explicit seeds later for selected online enrichment.

`--limit` defaults to 100,000 observations (range 1–10,000,000).
`complete` means the parsed input ended, `limited` means the requested limit was
reached, and `interrupted` means SIGINT/SIGTERM stopped ingestion; interrupted
CLI runs exit 130. The count includes existing source records observed again,
not only new inserts. Reruns start at the beginning and upsert idempotently.
Earlier committed batches survive an error; invalid metadata/XML fails visibly
instead of silently skipping records. Check logs for the last committed count.

The catalog's `MAX_ENTITIES` capacity still applies. The parser rejects DTDs,
entities and external references, nesting beyond 32 levels, decompressed input
beyond 32 GiB and record/read windows beyond 16 MiB. Large snapshots may require
independently prepared valid XML shards; gzip size is not decompressed size.
No complete-provider import or hardware throughput guarantee is implied.

“Due” is not “eligible”: disabled/paused sources and host backoff exclude claims
without consuming failure attempts. This prevents a throttled source from
starving other eligible hosts. Empty vector outboxes with current indexed
revisions mean caught up, not stalled. Heartbeats show workers waiting for
eligible work; five-minute observed/indexed totals use retained activity events,
not inferred container utilization.

## Parallelism and limits

Worker pools are bounded, with no prefetched backlog of leased jobs:

| Variable | Default | Range | Scope |
| --- | --- | --- | --- |
| `CRAWLER_WORKERS` | 8 | 1–32 | Concurrent fetch/parse workers per crawler container |
| `INDEXER_WORKERS` | 2 | 1–8 | Independent embedding workers per indexer container |
| `INDEX_BATCH_SIZE` | 64 | 1–256 | Maximum records claimed/embedded per index worker |
| `EMBEDDING_THREADS` | 2 | 1–32 | ONNX CPU threads per index worker model |
| `SOURCE_INTERVAL_SECONDS` | 4 | 0.1–3600 seconds | Default minimum spacing between request starts per upstream host |
| `SOURCE_INTERVAL_OVERRIDES` | empty | `source=seconds` comma-separated pairs | Override spacing independently for named adapters; shared across replicas |

Each crawl worker owns its HTTP/YouTube Music sessions; each index worker owns
its model and Qdrant client. PostgreSQL's thread-safe connection pool grows on
demand to accommodate the configured concurrency. Workers claim only when ready
to execute; `SKIP LOCKED` and lease tokens prevent duplicate active claims.
Each host cycles through five shared scheduling slots: one oldest-due exploration
slot, three bulk-discovery slots and one popularity-prioritized slot. Bulk
discovery selects artist catalogs and album/playlist track pages instead of
single-record enrichment, including Apple and Deezer album/artist lookups.
This favors new-record yield over single-record enrichment, not higher request
rates; exploration and priority slots retain enrichment opportunities.
If no eligible bulk work exists, that slot falls
back immediately to ordinary priority selection. All slots honor the same
source controls, host budgets and leases.

MusicBrainz release-group jobs browse at most three releases, then page at most
1,000 recordings per release. Each recording retains the explicit release-group
edge, without replacing richer metadata or previously observed memberships.
Larger pages fail visibly; the three-edition sample is not exhaustive. Ranker
sweeps admit at most 50 previously unscheduled albums per batch and stop at
1,000 due/ready release-group jobs, reserving admission space for both observed
or explicitly prioritized albums (200) and unranked albums (800). This allows
existing bulk-imported empty and
partial albums to be enriched without an unbounded queue flood. Jobs refresh
normally and share the host's admission, pause and retry controls.

Album job priority incorporates the actual decaying chart-derived popularity
of its explicitly credited artists; no ranks are manufactured. An operator may
also run `mint-catalog priority-artist <musicbrainz-artist-uuid> --provenance
<label>` to add a persistent, explicit priority label. Labels must be
non-sensitive lowercase identifiers, at most 64 characters. `--remove` removes
the specified label; ranker sweeps recalculate priorities. This input reads no
Mint database and does not automatically track additions or removals in a Mint
library. Priority is a scheduling preference, not a popularity observation.

Dispatch locks one eligible host with `SKIP LOCKED`, selects and leases its work,
and reserves its first request in the same transaction. The transport consumes
that admission once; redirects and YouTube Music follow-ups still reserve their
own slots. Shared cursors prevent workers restarting the discovery cycle at
the same exploration slot. Idle workers wait for the nearest relevant host
deadline (20 ms–1 second), rather than losing fractional slots to coarse polling.
Unchanged worker states refresh at most every five seconds; state/job transitions
remain immediate.

Apple lookup jobs batch up to five albums/artists or 50 songs of the same kind
and storefront into one ID-list request. A batch retains every job's fenced lease
and commits all completions atomically. Responses remain capped at 4 MiB and
1,005 records (201 for song batches). Failed jobs retry individually rather than
repeatedly poisoning batches; backoff defers every leased member without spending
failure attempts. Batches do not imply exhaustive artist or album enumeration.

Ingestion preloads existing documents and relationships per batch, deduplicates
neighbor scheduling and avoids rewriting unchanged edges/job priorities.
Shared host pacing, pause controls, response budgets and upstream backoff still
apply across all threads and replicas. Concurrency benefits independent
hosts and overlapping fetch/parse/embedding work, not unrestricted requests to
one source. Database mutations and vector publication retain the existing
budget lock, lock order and revision fencing; they are deliberately serialized
to preserve counters, capacity and stale-worker protection. The ranker retains
its single coordinated graph sweep. Each batch materializes neighbor scores
once and joins them to the selected records, rather than recalculating the
aggregation per record while holding the write lock. Unchanged popularity and
job-priority rows are not rewritten.

Per-source interval overrides accept fractions, for example
`SOURCE_INTERVAL_OVERRIDES=apple=3,ytmusic=1,deezer=0.5`. This increases configured
admission rates to 20/minute, 1/second and 2/second respectively; it does not assert
these are permitted quotas. Review each source's current access policy.
MusicBrainz defaults to 1 second independent of the global default and rejects
overrides below 1 second. Unknown/duplicate adapters and nonfinite/out-of-range
intervals fail startup. Every raw HTTP request, including redirects and
YouTube Music library subrequests, reserves the same persisted host slot.
Short redirect continuations retain their current URL while waiting, rather
than restarting the original request. A YouTube Music job whose first request
cannot start defers without sleeping in a worker; subsequent library requests
may wait within the existing elapsed-time budget to preserve continuation.
Fractional pacing deferrals remain fractional in the queue.
Startup logs print effective per-source intervals.

Hardware saturation is not a promise of HTTP crawling: remote latency, finite
discographies and upstream rate limits can remain the ceiling with idle CPUs.
For acquisition independent of per-record upstream requests, use permitted bulk
metadata exports through `import-jsonl`; never disable source backoff to make
utilization look higher.

Increasing configured rates never shortens a host's existing backoff. HTTP
401/403 quarantine, 429/503 delays and `Retry-After` remain authoritative.
`Shared upstream rate budget is not ready` reports local admission pacing,
not an upstream rate-limit response. Measure new records/request and actual
429/503 responses while tuning; faster configuration alone cannot guarantee
fewer rate limits or higher useful throughput.

To distinguish bottlenecks, inspect `crawl_complete` log fields:
`new_entities` counts inserted source-scoped records (not all observations),
`fetch_ms` includes source response time, `parse_ms` covers metadata parsing,
and `store_ms` includes the database transaction and admission-lock wait.
`rank_batch elapsed_ms` includes its transaction and any lock wait. A nearly
empty embedding outbox means embeddings are caught up, not that GPU inference
would accelerate discovery. Source pacing and request yield still bound crawl
throughput; increasing threads or changing the machine's IP does not remove
those constraints.

SIGTERM stops new work and waits for active operations to finish within their
existing timeouts. An unexpected worker exit/failure stops its sibling workers
and fails the process so Compose can restart it; unfinished leases remain
recoverable. Each worker has a unique console heartbeat; the snapshot includes
up to 100 workers, prioritizing live workers over stopped/stale entries. Models consume RAM
per worker, and replicas multiply all counts. Avoid oversubscribing CPU threads
or PostgreSQL connections; larger pools cannot help an empty embedding queue.
No GPU or source-pacing changes are implied by these settings.

To apply code/settings changes locally, run `docker compose up --build -d`.
Use `docker compose logs -f --tail=50 crawler indexer` to see pool sizes and
progress. Setting worker counts to `1` restores serial execution.

## Optional Mint bridge

The separate `bridge` Compose profile is off by default. It runs only the bridge
API, not the console, on the internal catalog network and exposes its port to
host loopback only. Set a private random `CATALOG_BRIDGE_TOKEN` (32–256 printable
ASCII characters) in the environment or an untracked `.env`; configure the same
token and URL on Mint. Set `CATALOG_BRIDGE_PORT` to change the host port.
All bridge routes require `Authorization: Bearer <token>`; missing or invalid
tokens receive 401. Rotate the token on both sides. Do not send it over an
untrusted plaintext network, expose the console, or use this interface as a
public API. Container-to-host connectivity requires an explicitly configured
private route; loopback on a container is not the host's loopback.

For separate Compose deployments on the same Docker host, an operator can use
the optional `compose.bridge.yml` overlay. Create a dedicated internal Docker
network and a private CA-signed certificate with DNS SAN `mint-catalog-bridge`;
mount the certificate and key as readable files for catalog UID 10001, and make
the CA available to Mint's client. Do not mount the private key into Mint.

```sh
docker network create --internal mint-catalog-bridge
# Set CATALOG_BRIDGE_TOKEN, CATALOG_BRIDGE_TLS_CERT_FILE and
# CATALOG_BRIDGE_TLS_KEY_FILE to private operator-provided values first.
docker compose -f compose.yml -f compose.bridge.yml --profile bridge up -d bridge
```

Attach only Mint services that need this interface to the same external
`mint-catalog-bridge` network and configure
`https://mint-catalog-bridge:8080` as their URL. The network name can be changed
with `CATALOG_BRIDGE_NETWORK` on both stacks. The overlay mounts only the
certificate/key into the bridge and enables TLS; it does not attach or publish
the console. Keep both files and the token out of tracked configuration, protect
their permissions, and provision CA trust in Mint before connecting. The plain
default loopback listener remains intended only for same-host clients.

`GET /v1/artists/{artist_mbid}/albums` and
`GET /v1/albums/{release_group_mbid}/recordings` return
`{"items":[{"id":"...","title":"...","artist":"...","url":"..."}],"next_cursor":null}`.
Identifiers and URLs are explicitly MusicBrainz-scoped; parent records absent
from the catalog return 404. Pass `limit` (1–100) and `after` (the previous
`next_cursor`) to page by ID. Pages are current reads, not a frozen snapshot.

`POST /v1/priority/artists` accepts `{"add":[...],"remove":[...]}` with 1–100
unique, disjoint MusicBrainz artist UUIDs total and returns
`{"added":n,"removed":n}`. Changes are idempotent and use the fixed
`mint-library` provenance; omissions do not remove IDs. Only explicit verified
IDs belong in this feed, never names, users, credentials or other library data.
It affects crawl scheduling only, does not alter popularity signals, and never
requests or downloads audio. Payloads are limited to 16 KiB, concurrent requests
to eight, and database statements to two seconds. Rate and source backoff still
govern every subsequent upstream crawl.

## Raw data browser

Open `/data` from the console navigation. PostgreSQL browsing includes all 15
standalone catalog tables, every stored column, column types, nulls and
generated fields. The exact filter matches the first primary-key column
(for example an entity key or an activity ID). Composite-key tables page by
their complete primary keys. `infinity` timestamps remain strings.

Qdrant shows only the configured catalog collection: point UUIDs, full payloads,
reported collection count/status and dimension count. Filter by exact
`payload.key`; select a point to fetch its complete stored floating-point
vector. These are not the INT8 quantized search values. The reported collection
count is not a filtered total. PostgreSQL remains independently browsable if
Qdrant requests fail.

Pages contain 1–50 rows with opaque keyset/scroll cursors, Previous/Next and
manual refresh; they are live reads, not a consistent export during crawling.
The raw inspector and Copy JSON use server-serialized JSON so large integer
values are not rounded by JavaScript. Table cells are abbreviated previews.
No arbitrary SQL, collection names, other databases, mutations or database
connection details are exposed. PostgreSQL uses read-only transactions and
two-second statements; Qdrant scrolling/retrieval has a three-second server
budget. Browser requests have a four-request concurrency cap.

Read-only endpoints:

- `GET /v1/data/tables`: allowlisted tables, primary keys and column types.
- `GET /v1/data/postgres/{table}?limit=25&exact=...&after=...`: raw rows,
  precision-preserving `raw_rows` JSON strings and next cursor.
- `GET /v1/data/vectors?limit=25&exact=...&after=...`: point payload pages.
- `GET /v1/data/vectors/{uuid}`: full payload/vector and `raw_json` string.

This is the same loopback-only operator tool, **not an authenticated database
administration service**. Keep it private.

## Run independently

Requires Docker Compose v2 and outbound HTTPS to enabled sources and the public
embedding-model download host. No upstream accounts or API keys are required.

```sh
cd services/catalog
cp .env.example .env
# Edit CRAWLER_USER_AGENT to identify your application/version and public contact.
docker compose up --build -d
curl 'http://127.0.0.1:8097/readyz'
curl 'http://127.0.0.1:8097/v1/search?q=ambient&kind=song&limit=10'
docker compose exec crawler mint-catalog status
```

Default discovery starts with ListenBrainz weekly recordings, fetches MusicBrainz
recordings and their explicit artist/release-group links, and expands artists
through independently paginated discographies. Enable Apple with
`APPLE_ENABLED=true` and set `COUNTRIES=us,gb` for additional storefront seeds.
Use documented storefronts; invalid/unavailable country feeds fail visibly.

Services:
`metadata` (PostgreSQL), `vectors` (Qdrant), `initialize` (schema/index setup),
`crawler`, `indexer`, `ranker`, and `search`. Initialization retries boundedly if
Qdrant has not started yet. Search/indexer download the fixed local
`sentence-transformers/all-MiniLM-L6-v2` model on first start; models persist in
their shared cache volume. Initial readiness can take longer than subsequent
starts. Model inference needs no external API and queries are never sent to an
embedding provider.

The host search port binds **only to loopback**. Both databases are unexposed on
an internal network. PostgreSQL uses trust authentication only inside this
dedicated network, not Mint's credentials. Do not attach untrusted containers or
publish database ports. Configure authentication, TLS and request-rate controls
at a reverse proxy before exposing search beyond this host; this service does
not implement a public multi-tenant API.

Scale roles independently without changing Mint:

```sh
docker compose up -d --scale crawler=3 --scale indexer=2 --scale search=1
docker compose logs --tail=100 crawler indexer ranker
```

Upstream rate budgets remain shared in PostgreSQL: more crawler replicas do
**not** bypass upstream limits. Indexers and search replicas each load their own
model; size CPU/RAM and PostgreSQL connection budgets accordingly. Search's
published host port permits one replica as configured; multiple replicas require
an operator-managed load balancer instead of this fixed port.

## Search and graph contract

`GET /v1/search?q=...`

- Optional `kind=artist|album|song`, `source` from the 11 entity namespaces
  listed in [SOURCES.md](SOURCES.md) (ListenBrainz supplies MusicBrainz identities),
  `country=us|gb|...|global`, `limit=1..50`, `mode=hybrid|lexical`,
  `group_artists=true|false` (default true).
- Hybrid combines PostgreSQL lexical ranking with Qdrant semantic candidates
  using reciprocal-rank fusion, then groups verified artist identities before
  applying the result limit. The highest-ranked matching record represents each
  group; repeated provider records do not multiply its score.
  At most 200 candidates per ranking are fetched; no unbounded result hydration.
- Responses include `query`, `mode`, `results`, and `has_more`, which indicates
  more **retrieved candidates**, not exhaustive pagination or a total count.
  Results include provenance (`source` identity versus metadata `origin`),
  source URL, storefront/scope, materialized popularity, freshness and revisions.
- Hybrid returns 503 when a dependency fails. Request `mode=lexical` explicitly
  to search PostgreSQL without Qdrant; there is no success-shaped silent fallback.
- Whitespace-only queries, unsupported filters and oversized limits fail
  validation. A per-process concurrency budget bounds search admission. Responses
  negotiate gzip above 1 KiB; SQL search has a two-second statement budget.

`GET /v1/entities/{key}` returns an entity, up to 100 incoming/outgoing graph
edges with `edges_truncated`, its current source signals, up to 100 explicit
provider links and retained attribution annotations. Example keys:
`apple:us:song:123` or
`musicbrainz:global:song:00000000-0000-4000-8000-000000000003`.
`GET /healthz` is liveness; `/readyz` checks schema and vector collection after
the local model has loaded. `/docs` explains the API; `/openapi.json` is its schema.

Source identity and metadata provenance are separate: ListenBrainz supplies
initial metadata for an explicit MusicBrainz recording ID; a later MusicBrainz
lookup replaces that partial metadata. Artist names or titles never cause a
cross-provider merge. Unlinked artist matches, albums and songs remain separate.

## Catalog brain and artist relationship graph

`GET /v1/console/atlas` returns the complete grouped overview, with
`scope=atlas`, `total_records`, `represented`, `genre_tags`, `tag_memberships`,
`unresolved_links`, `nodes`, `edges`, `branch`, `unit`, `at` and `notice`.
Every raw stored record belongs to exactly one provider/type root; aliases are
counted as separate records here. Genre tags are counted separately from records.
Unfetched edge targets are reported, not invented as records.
Each group node includes `count` and a `{source,kind,prefix}` drilldown target.
Supply those fields to refine a branch. Hex prefixes are bounded to 32 digits;
unknown sources/types or malformed prefixes return 422. Branch responses report
the number of records/tags represented by that branch; context groups are marked
`context=true` and do not add to that count. Leaf records retain source URLs.
Edge `count` is an aggregate of stored relationships, never similarity or
collaboration-role evidence. Selecting an individual record exposes its original
metadata and an explicit action to open its record-explorer neighborhood.

The root is cached for 30 seconds and all grouping queries use read-only,
repeatable-read transactions with a ten-second per-statement limit. Concurrent
root refreshes return a visible retryable 503 instead of duplicating the full
aggregate scan. Requests share the existing four-query graph admission cap.
Branches are fresh reads and may grow while crawling; this is not a frozen
full-catalog export. Root aggregation scans the catalog, edges and tags, not just
recent or top-ranked records. Large-catalog latency depends on database resources;
the bounded browser payload does not prove multi-million-record query latency.

`GET /v1/console/catalog-network` accepts `q` (up to 100 characters),
`limit=1..20` (default 10 roots per kind), and opaque `after` from `next`.
Without `key`, root pages independently advance artist, album and song keysets.
With a stored entity `key`, `after` pages its incoming/outgoing neighbors; artist
focus includes verified aliases. A derived `genre:` key expands only records
with that normalized explicit tag, not a fictional entity or inferred matches.
Each page adds bounded outgoing artist/album targets and returns actual stored
edges plus attributed tag edges. The response includes `scope=catalog`, `focus`,
`nodes`, `edges`, `next`, `truncated`, `limits` and `notice`. Counts/evidence describe
the loaded slice only. Genre nodes are derived (`kind=genre`, `source=catalog`);
other records retain their provider attribution. Empty unknown genres return
404; malformed keys/cursors fail validation. Requests share the artist graph's
four-query admission cap and two-second SQL statement budget.

`GET /v1/console/artist-network` accepts optional `q` (up to 100 characters,
PostgreSQL simple full-text terms), `limit=1..20` (default 12) and `after`
(the previous response's `next` value). Root pages use canonical artist ID
keysets, not recent-record sampling or offset scans. Pages replace the visible
catalog slice, so the 180-node view cap does not prevent browsing later artists.
Search matches all stored aliases, while the graph displays one representative
per verified canonical group and its `sources`.

Pass `key={source-scoped-artist-key}` to focus a neighborhood. With a focus,
`after`/`next` instead page the artist's credited record keys. An overview samples
10 credited records per root; a focused request samples 50 and returns up to 20
other stored canonical artists per credited record. Each query has a two-second
statement timeout; at most four network requests execute concurrently.

An edge's `relation=shared_credit` means both artists are explicitly credited by
stored `edges` on the same song/video or album. Each edge carries up to five
source-attributed evidence records (key, title, kind and URL), an
`evidence_count` for the retrieved slice (not a catalog-wide total), and
`evidence_truncated`. Shared album credits can be compilations; neither credits
nor identity links establish friendship, influence, genre similarity or a
specific collaboration role. Missing/unfetched artists are not fabricated.
Canonical alias records collapse to one node, not an artist-to-artist edge.

The response includes `scope`, `focus`, `nodes`, `edges`, `next`, `truncated`,
`limits` and `notice`. `limits` distinguishes overview-credit sampling,
per-record peer truncation and view capacity. Responses and accumulated browser
neighborhoods cap at 180 nodes/400 edges. More credits merges neighborhoods
without duplicating identity nodes or evidence. The list exposes the selected
artist's connections and source evidence; Fit changes only pan/zoom, Overview
clears the selection/query, and Expand enlarges the graph panel. If capacity is
reached, start a new overview or find a specific artist. No full-catalog graph
or exhaustive connection counts are claimed.

The renderer is **Cytoscape.js 3.34.4** (MIT), bundled in the Python package and
served from the same origin. No CDN, external graph service, API key or browser
build step is needed to start the container. Organic uses Cytoscape's bounded
CoSE layout; Radial uses its concentric layout. Layouts settle once, not as a
perpetual simulation. Metadata refreshes with unchanged topology retain dragged
positions and viewport; adding/removing relationships triggers a fresh layout.
Labels adapt to viewport density, with full names available on hover or through
the record picker. Node spacing is adjustable; complete-coverage groups preserve
aggregate internal links as loops. Focus neighbors temporarily hides unrelated loaded records;
Show all loaded restores them without requesting data or discarding evidence.

Select an edge to isolate its evidence list. Use the record picker and connection
buttons for keyboard/screen-reader inspection; the canvas is not an accessible
replacement for those controls. With the graph focused, arrow keys pan, `+`/`-`
zoom, `0` fits and Escape clears selection/focus. Fit changes only the viewport.
Viewport animation respects reduced motion. If the renderer fails to load, an
explicit error is shown and the record/evidence controls remain usable.

## Artist identity

`entities` retains every source record. Its generated `artist_identity` normalizes
only exact provider identifiers: the shared YouTube/YouTube Music UC channel
namespace and Apple artist IDs across storefronts. `canonical_artists` is a
rebuildable mapping from these identities to a canonical group. Group IDs are
derived from the smallest member identity and can change when evidence changes;
continue using source-scoped entity keys as permanent record addresses.

Automatic cross-provider artist grouping uses only explicit artist links
asserted by MusicBrainz or Wikidata. It never uses names, title fingerprints or
embedding similarity as proof. Exact YouTube channel URLs and Wikidata channel
IDs are supported; handles and inferred channel/performer equivalence are not.
Links may connect records that arrive later; only stored records appear in the
provider list. A group cannot contain two different IDs from the same normalized
provider namespace: competing assertions remain separate with
`entity_links.canonical_status=conflict` and a warning in crawler logs.

Both search and entity detail return `canonical_id`, up to 100 stored `providers`
(record key, source, scope, provider ID, title and URL), and
`providers_truncated` for artists. Source/country filters still select the matching
representative, while its provider list preserves the broader attribution.
`group_artists=false` retrieves individual results without changing stored groups.
Vector revision filtering happens before grouping; stale semantic matches cannot
resurrect an artist through its group. Graph nodes and raw vectors remain
source-scoped rather than rewriting factual relationships.

The v4 migration backfills stored evidence atomically. Newly ingested artists and
links reconcile in the same budget-locked transaction as their metadata.
Rebuild derived groups from retained evidence without re-embedding:

```sh
docker compose exec crawler mint-catalog reconcile-artists
# Optionally schedule existing unleased, non-dead authoritative artist jobs now:
docker compose exec crawler mint-catalog reconcile-artists --refresh-evidence
```

Inspect `entity_links` and `canonical_artists` in `/data`. An explicit link is
evidence, not infallible truth; source assertions may be wrong or out of date.
Exclude an incorrect assertion and atomically rebuild/split its group:

```sh
docker compose exec crawler mint-catalog exclude-artist-link \
  'musicbrainz:global:artist:00000000-0000-4000-8000-000000000001' deezer '123'
```

Replace the example with the evidence record key, linked provider and linked
identifier. Exclusions survive reobservation and rebuilds. Other independent
accepted paths can still connect the same records; inspect/exclude those too if
necessary. Raw records, links, source counts, attribution and vector IDs are
never deleted by reconciliation. Rebuilds hold the admission lock and can pause
writes on large catalogs; run them during a quiet period. No audio fingerprints,
fuzzy auto-merges or album/recording equivalence are implemented.

## Popularity, reliability and storage

Chart rank contributes `1/log2(rank+1)`, decayed with a seven-day exponential
time constant from the source chart's timestamp/window end. Structural edges
propagate a bounded single-hop weighted contribution: 0.35 toward related
artists/albums and 0.15 back toward recordings. This is a reproducible discovery
priority proxy, **not** a global play count, full PageRank or personalized signal.
Public views, plays and item downloads use `log(1+raw_count)/20`, with raw values
and signal kinds retained; they are scoped observations, not comparable global
listening counts. Unranked trending/feed order never becomes a synthetic rank.
The ranker sweeps indexed keyset batches, then waits five minutes.

Four out of five crawler claims prioritize popularity; the fifth serves oldest
due work. Scheduled refreshes are promoted in bounded batches to a separate
ready lane, so future jobs do not dominate the priority index. Claims use
`FOR UPDATE SKIP LOCKED`, expiring leases and fencing tokens. Crawl metadata,
relationships, chart replacement, discovered jobs and vector-outbox entries
commit atomically. High-detail metadata/relationships survive partial chart or
browse refreshes. An interrupted worker's jobs become claimable after five
minutes. Successful chart jobs recur every six hours; lookups/pages every seven
days. Discovery is bounded at 100,000 browse offsets per artist and finite
provider response sizes; hitting a budget is an error, not a claim of completion.

429/503 and Retry-After pause the shared host budget; 401/403 pause for at least
24 hours, with no credential or browser workaround. Deferrals do not burn the
failure budget. Other known failures back off exponentially and dead-letter
after eight failed attempts; inspect counts/errors using `status` and logs.
Exception type codes persist rather than raw upstream response bodies. Retry
one inspected key with:

```sh
docker compose exec crawler mint-catalog retry jobs 'the-exact-job-key'
docker compose exec indexer mint-catalog retry vector_outbox 'the-exact-entity-key'
```

The outbox publishes revision-checked embeddings, then acknowledges the indexed
revision. Retries are idempotent; stale workers cannot acknowledge newer work.
Search excludes stale semantic revisions during reindexing. Qdrant uses
384-dimensional vectors, disk-backed vectors/HNSW, INT8 scalar quantization and
payload indexes for scope filters. Quantization reduces the vector working set,
not metadata size; raw vectors remain available on disk for rescoring. Embeddings
are not lossless compression and do not replace PostgreSQL metadata.

For a missing or deliberately rebuilt Qdrant collection, stop indexers/search,
then run initialization and the bounded, idempotent reindex command:

```sh
docker compose stop indexer search
docker compose run --rm initialize
docker compose run --rm crawler reindex
docker compose up -d indexer search
```

Reindex queues current entity revisions and clears their indexed acknowledgments;
it does not fetch upstream data. Never reuse this collection
with a different embedding model; model/schema changes require an explicit
migration/reindex plan. Back up PostgreSQL and Qdrant consistently; model cache
is redownloadable. No automatic entity deletion is performed.

## Bootstrap and realistic scale

The storage/search layout is intended for multi-million-item catalogs, but this
is not evidence of multi-million-item performance. Measure index-build time,
disk usage, resident memory and p50/p95 search latency on the intended dataset
and host before production sizing. Public rate-limited crawls cannot populate
millions of complete records quickly and charts do not guarantee full coverage.
Use permitted bulk/open datasets for initial population, then crawl incrementally.

Seed an explicit ID without requiring a chart appearance:

```sh
docker compose exec crawler mint-catalog seed musicbrainz artist MUSICBRAINZ_UUID
docker compose exec crawler mint-catalog seed apple artist APPLE_ID --country us
```

For authorized exports, `import-jsonl PATH` streams normalized metadata, commits
128-record batches, applies the same admission/outbox logic and can safely be
rerun. Earlier committed batches remain if a later line fails; fix the reported
line and rerun. Mount the file into a one-off service container, for example:

```sh
docker compose run --rm -v /absolute/export.jsonl:/imports/catalog.jsonl:ro \
  crawler import-jsonl /imports/catalog.jsonl
```

One JSON object per line (this is **not** a raw MusicBrainz dump importer):

```json
{"source":"musicbrainz","country":"global","kind":"song","provider_id":"00000000-0000-4000-8000-000000000003","title":"Example Song","artist":"Example Artist","artist_ids":["00000000-0000-4000-8000-000000000001"],"album_ids":["00000000-0000-4000-8000-000000000002"],"genres":[]}
```

Supported import sources are `musicbrainz`, `apple`, `youtube`, `ytmusic`,
`spotify`, `deezer`, `audius`, `archive`, `wikidata` and `soundcloud`.
Openverse JSONL imports are rejected because this import shape lacks required
attribution; use its adapter. Apple rows also require their
HTTPS `url` and storefront `country`. Optional fields: `artist`, `album`,
`artist_ids`, `album_ids`, `genres`. Maximum line size is 64 KiB, 100 related
artists/albums and 20 genres. Adapt permitted source exports to this contract
outside Mint. Default `MAX_ENTITIES=10000000` enforces atomic admission; it is a
safety cap, not a performance assertion. Imported entities can queue incremental
lookups; disabled sources do not execute requests or delete existing data.

## Focused development checks

Python 3.12+; Node 20+ for graph adapter and actual Cytoscape layout tests.
There are no Mint workspace dependencies:

```sh
cd services/catalog
python3 -m venv .venv
. .venv/bin/activate
pip install -e '.[test]'
pytest
ruff check .
node --test tests/graph-layout.test.cjs
docker compose config --quiet
```

The checked-in browser bundle is generated from the standalone `package.json`
and npm integrity lock. To regenerate it, run `npm ci --ignore-scripts` then
`npm run vendor` **inside `services/catalog`**. Preserve `cytoscape.LICENSE.txt`;
the graph tests check the packaged version and bundle checksum. Updating
Cytoscape also requires updating that checksum and exercising both layouts in
a real browser. Node/npm and `node_modules` are not needed in the runtime image.

Unit tests need no network. Integration tests skip unless
`CATALOG_TEST_DATABASE_URL` points to an **isolated disposable PostgreSQL admin
connection** allowed to create databases. They create/drop only their own
uniquely named test databases; do not point at a real deployment.
Tests normally exercise Qdrant's local implementation with deterministic fixture
embeddings. To exercise a separately started **disposable** Qdrant server and the
real local embedding model, also set `CATALOG_TEST_QDRANT_URL` and
`CATALOG_TEST_MODEL_CACHE`. Tests create/drop only their own UUID-named vector
collections. No test proves container startup or multi-million-item
HNSW/quantization performance. Do not claim production latency or full catalog
coverage from these bounded fixtures.

For focused future agent sessions, route by `services/catalog` rather than the
ambiguous word "catalog"; the latter can also match Mint's existing library.
