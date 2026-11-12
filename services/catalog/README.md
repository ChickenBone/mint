# Mint Catalog

Standalone music metadata aggregation, evidence-backed recording reconciliation,
popularity graph and local vector search. MusicBrainz snapshots provide the
foundation; targeted crawling enriches source coverage rather than replacing it.
It runs independently by default, with an optional private Mint bridge.
No upstream API keys are used.

## Start locally

Install Docker Desktop (or Docker Engine with Compose), then:

```sh
cd services/catalog
cp .env.example .env
# Optionally edit .env to identify your own application/contact.
docker compose up --build -d
```

Open **http://localhost:8097** for the live console.

The first start downloads the local embedding model, so allow a few minutes.
If the page is not ready yet, check:

```sh
docker compose ps
docker compose logs -f --tail=50 search indexer initialize
```

## See what it is doing

The dashboard puts storage and pipeline health above a full-width embedding map:

- **Storage:** measured PostgreSQL database size in GB, with table, SQL-index and
  queue sizes under **Storage breakdown**. Measurements refresh every 30 seconds.
  Qdrant disk usage is explicitly unavailable, not guessed or included in PostgreSQL.
- **Pipeline:** stored records, current vectors, crawl queue, recent retained
  observations and failures update every five seconds.
- **Embedding Atlas:** Apple's locally bundled WebGPU renderer is the default.
  Points use current catalog metadata vectors projected into two dimensions,
  colored by artist, album or song. Switch between points and density, inspect
  source records, or filter the loaded-record picker by name, artist or source.
  The first page loads 2,048 vectors; **Load indexed catalog** streams more,
  with **Stop loading** and an explicit one-million-point browser limit.
  Coverage reports displayed/loaded, indexed and stored counts separately.
  Projection is approximate sample PCA, not audio similarity, provider identity,
  graph edges or a whole-catalog UMAP fit. Missing/stale embeddings are omitted;
  genre tags remain in the inspector and relationship views.
  WebGPU with `shader-f16` requires a compatible browser on localhost or HTTPS.
  The keyboard record picker and relationship views remain usable without it.
- **Whole catalog groups:** every stored record is counted in provider/type groups,
  alongside explicit genre tags and aggregate relationship counts. Zoom into or
  select a group to expand it; breadcrumbs return to its parent or the whole catalog.
  Large groups split into smaller key partitions instead of dropping records.
  These are storage groups, not claims about musical similarity.
  **Record explorer** shows individual artists, genres, songs and albums with
  source evidence. Finding a name/genre opens this mode. **Artist connections**
  retains shared-credit exploration; **Recent records** retains the live crawl view.
  The locally bundled **Cytoscape.js** graph supports draggable nodes, mouse/pinch
  zoom, **Organic / Radial** layouts, **Node spacing**, **Focus neighbors**, Fit
  and Expand. Default spacing is wider. Select a link to inspect its aggregate
  count or record evidence. The record picker and evidence buttons provide
  keyboard/screen-reader alternatives to the canvas.
- **Sources & workers / Live activity:** expand these sections below the graph
  for pause/resume controls, heartbeats, completed work and errors.
- **Search:** keyword + local-vector search; select a result to inspect it.
- **Operations:** add seeds, inspect host backoff and retry failed jobs.
- **Data browser:** open **http://localhost:8097/data** (or Data browser in the
  navigation) to inspect raw PostgreSQL rows and Qdrant payloads/vectors.
  Choose a database/table, page through records, filter by an exact key, and
  select **Inspect** for complete JSON. This view cannot edit or delete data.

Pause view freezes the display, **not** the crawler. Source Pause stops new
claims for that adapter; already-running work may finish.

Follow full service logs or get a JSON summary:

```sh
docker compose logs -f --tail=50 crawler indexer ranker
docker compose exec crawler mint-catalog status
```

## Sources

There are **14 implemented adapters**. The example configuration enables
MusicBrainz, ListenBrainz, YouTube Music, YouTube, Spotify, Deezer, Audius,
Internet Archive, Wikidata, SoundCloud, Openverse, Discogs and Openwhyd. Apple is optional.
An additional **Openmusic Database bulk reader** accepts local PostgreSQL dumps.
See [SOURCES.md](SOURCES.md) for all **27 researched sources**, references and
honest access/coverage limits.

Deezer charts, Audius trending, Live Music Archive downloads and Openverse
music metadata add automatic discovery. Spotify and SoundCloud support limited
public oEmbed lookups, **not full catalog/search/chart crawling**. Openwhyd's
public hot-track export supplies additional explicit YouTube/SoundCloud IDs,
not personal profiles or invented chart ranks. Discogs supports keyless
artist/master/release metadata, paginated discographies and explicit genres;
styles are separately attributed. Wikidata and
MusicBrainz preserve explicit provider links without merging matching names.
Amazon's documented API requires credentials; only explicit Amazon links are
retained, not a fictional no-key Amazon crawler.

**Upgrading an existing installation:** add this line to your existing `.env`
(do not overwrite the file), then rebuild:

```dotenv
PUBLIC_SOURCES=spotify,deezer,audius,archive,wikidata,soundcloud,openverse,discogs,openwhyd
```

```sh
docker compose up --build -d
```

The additive schema upgrade keeps existing records and queues. Back up first;
see [OPERATIONS.md](OPERATIONS.md).

### Bulk metadata without per-record HTTP

For millions of records, use the **bulk snapshot loader**, not per-ID HTTP crawling.
PostgreSQL ingestion uses `COPY` staging and set-based entity, credit, counter,
queue and outbox writes. MusicBrainz/OMDB imports commit up to 2,048 observations
at a time and checkpoint progress in the catalog database. They do not generate
millions of HTTP enrichment jobs. Keyword search sees committed data immediately;
embedding workers catch up independently.

The optional loader downloads official MusicBrainz archives, resumes partial
downloads, verifies published SHA-256 checksums and imports artists, release groups,
standalone recordings and **recordings nested in releases**:

```sh
# In .env, choose a capacity and storage directory appropriate for your disk.
# Example: MAX_ENTITIES=100000000
mkdir -p imports
docker compose --profile bulk run --rm --no-deps --user 0 \
  --entrypoint chown bulk-import 10001:10001 /imports
docker compose --profile bulk up --build -d bulk-import
docker compose logs -f --tail=20 bulk-import
```

`CATALOG_IMPORT_DIRECTORY` selects the host download directory (default `./imports`).
`MUSICBRAINZ_SNAPSHOT` can pin an official `YYYYMMDD-HHMMSS` snapshot; empty selects
the latest available snapshot when the service starts. Downloads are many GB;
metadata, SQL indexes and vectors require additional disk. The service stays
separate from Mint, uses existing catalog volumes and retries failed runs up to
five times. A restart resumes the last committed checkpoint; compressed input
must still be decompressed again to reach it.

Import an already downloaded MusicBrainz archive instead:

```sh
docker compose run --rm --no-deps -v /absolute/path/to/dumps:/imports:ro crawler \
  import-musicbrainz /imports/artist.tar.xz --kind artist
```

For Openmusic Database, the metadata reader accepts its original PostgreSQL
tar/custom dump without restoring or executing downloaded SQL:

```sh
docker compose run --rm --no-deps -v /absolute/path/to/dumps:/imports:ro crawler \
  import-omdb /imports/fulldb.tar --kind artist
```

Import kinds in order: `artist`, `album`, `song`, `album-artists`, `song-artists`,
`song-features`. Playback tables, audio URLs, images and external lyrics IDs are
not imported. The publisher's current download links may be expired; no alternate
mirror or access bypass is supplied. See [large-import operations](OPERATIONS.md#large-database-imports)
for limits, provenance, restart and capacity details.

[Discogs publishes monthly CC0 XML dumps](https://data.discogs.com/).
Download a chosen artist/master/release dump yourself, then stream a local
`.xml` or `.xml.gz` file into the catalog:

```sh
docker compose run --rm --no-deps -v /absolute/path/to/dumps:/imports:ro crawler \
  import-discogs /imports/artists.xml.gz --kind artist --limit 100000
docker compose run --rm --no-deps -v /absolute/path/to/dumps:/imports:ro crawler \
  import-discogs /imports/masters.xml.gz --kind master --limit 100000
```

Use the actual downloaded filenames. Choose `--kind release` for release dumps.
The Discogs XML reader writes normal searchable metadata, relationships and embedding jobs in
128-record transactions, **without enqueuing a per-record HTTP lookup**.
It is the bulk path that avoids upstream request ceilings; network crawling
still respects provider budgets. Nothing automatically downloads multi-GB dumps.
Imports are idempotent and bounded; `limited` means the requested observation
limit was reached, not that the whole file was imported. See the
[import limits](OPERATIONS.md#discogs-bulk-import) before large runs.

YouTube Music starts from country charts and expands through returned artist,
album and video IDs. Access is unofficial and may fail or change; failures are
visible. Unranked results are not assigned invented ranks.

YouTube uses public channel feeds and video oEmbed metadata. Add a channel or
video ID in **Operations → Add a discovery seed**, or configure
`YOUTUBE_CHANNELS=UC...` in `.env`. Feeds cover recent uploads, not full histories.

Set `APPLE_ENABLED=true` to add Apple charts/lookups. Set `COUNTRIES=us,gb` for
storefront discovery. After editing `.env`, apply changes:

```sh
docker compose up -d
```

**Reading the pipeline:** “due” includes work waiting for host backoff, disabled
sources or source pauses; “eligible” means claimable now. Active means currently
leased, not the number of running crawler containers. Zero pending embeddings
with current vectors means indexing has caught up. Worker heartbeats and
five-minute observations distinguish healthy waiting from missing workers.

Metadata only: no audio, login cookies, API credentials or media downloads.
Public access does not grant unrestricted reuse; review source terms.

**Whole catalog** represents the entire stored catalog at once through exact
group counts, not millions of individual browser nodes. It does not impose the
record explorer's 180-node cap on catalog coverage. Groups refine recursively
until at most 80 records can be shown, with other connected provider/type groups
as context. The overview refreshes every 30 seconds; each branch is a fresh read,
not a frozen export during crawling.

**Record explorer** is an expandable window: pages balance artists, albums and
songs; selecting a node accumulates neighborhoods up to 180 nodes/400 links. Genre hubs
normalize explicit source tags, not inferred styles. Evidence
lists name the actual songs/albums carrying each relationship. A shared album credit is not proof of
a duet, friendship or stylistic similarity. Missing artist records and credits
cannot be drawn; the view labels sampling and capacity limits explicitly.
Whole-catalog counts describe source-scoped records, including provider aliases,
not deduplicated songs or unique musical artists.

## One artist, multiple providers

Search groups artist records when MusicBrainz or Wikidata explicitly links their
provider IDs. One result shows the linked providers; inspect it for each original
source link. Same names alone never merge artists. YouTube/YouTube Music records
with the exact same channel ID, and Apple storefront records with the same artist
ID, also share an identity. Albums and songs remain separate: matching titles do
not prove the same release or recording.

Schema v4 backfills existing artist links automatically when you rebuild.
Raw PostgreSQL records, attribution, relationships and vectors are retained.
Without an explicit linking identity, two same-named artists remain separate.
To rebuild groups and refresh existing authoritative artist jobs:

```sh
docker compose exec crawler mint-catalog reconcile-artists --refresh-evidence
```

This queues normal, rate-budgeted refreshes; it does not invent missing links or
perform name-based searches. [Identity operations](OPERATIONS.md#artist-identity)
explain how to inspect conflicts, undo an incorrect link and retrieve raw results.

## Recording reconciliation

`POST /v1/reconcile/recordings` separates **explicit provider identity evidence**
from **metadata-only candidates**. It never merges or deletes source records:

```sh
curl --fail-with-body http://localhost:8097/v1/reconcile/recordings \
  -H 'Content-Type: application/json' \
  -d '{"title":"Northern Lights","artist":"Example Artist","duration_ms":180000}'
```

Provide `references` when an ID is known, for example
`[{"source":"deezer","identifier":"123"}]`, or a MusicBrainz recording UUID.
Apple references also require their actual `country` storefront. Caller-supplied
URLs are not fetched. The resolver uses stored IDs and nonexcluded explicit
MusicBrainz/Wikidata links, including links retained from newly imported
MusicBrainz recordings. Exact YouTube/YouTube Music video IDs share an identity;
names, embeddings, ISRCs and popularity never establish one.

The versioned response reports `identified`, `ambiguous`, `candidates` or
`no_match`, with original records, authority URLs, observation times, evidence
and conflicts. Exact metadata remains review-only. Conflicting authority IDs
or supplied title/artist/version/duration require review. Durations within two
seconds are supporting evidence, not acoustic verification. `rank_score` orders
metadata evidence; **it is not a probability**.

Each request is read-only, capped at five references, a 32 KiB body and ten
returned candidates. Indexed ID/authority lookups and bounded lexical candidate
windows run with two-second SQL statement budgets; overflow is explicit.
This initial matcher is conservative, not a typo-tolerant or comprehensive
recording deduplication engine. Missing records/links limit recall. Existing
completed snapshots are not automatically reimported to enrich evidence.

The separate [Library Auditor](../library-auditor/README.md) can consume this
HTTP contract for read-only metadata-quality reports without Mint integration.
Labeled regression cases cover exact/accented names, different artists,
live/remix versions, duration conflicts and competing authority IDs; they are
not a claim of measured precision over a real music library.

## Parallel workers

Each crawler container runs **8 concurrent workers**, each with its own HTTP and
YouTube Music sessions. Each indexer runs **2 concurrent workers**, each with
its own embedding model, processing up to **64 records per batch** with
**2 embedding CPU threads**. Crawling, embedding, ranking and search run
independently. The console reports each worker separately.

Tune these settings in `.env`, then rebuild/recreate the services:

```dotenv
CRAWLER_WORKERS=8
INDEXER_WORKERS=2
INDEX_BATCH_SIZE=64
EMBEDDING_THREADS=2
```

```sh
docker compose up --build -d
```

More workers overlap requests and embeddings; they do not bypass shared source
budgets, pauses or backoff. Idle CPUs are normal when no eligible work exists.
Each indexer worker loads another model into RAM. Start with the defaults and
increase gradually; multiplying replicas also multiplies these worker counts.
The scheduler devotes three of five shared per-host slots to bulk artist/album discovery, with
one oldest-due exploration slot and one popularity-priority slot for enrichment.
Empty bulk slots fall back to ordinary work. This increases discovery yield
without raising upstream request rates.
MusicBrainz album enrichment browses up to three explicit releases per release
group and pages their recordings, retaining release-group membership even when
other recording metadata is richer. Existing imported albums are admitted in
bounded batches, including partially populated albums. This is not exhaustive
coverage of every edition; rate limits and normal refresh schedules still apply.
Observed artist popularity helps prioritize their albums, while an oldest-due
slot continues long-tail work.

An operator can prioritize a known MusicBrainz artist without connecting Mint's
database to this service:

```sh
docker compose exec crawler mint-catalog priority-artist 00000000-0000-4000-8000-000000000001 --provenance library-export
```

Use the actual artist UUID and a non-sensitive provenance label. Add `--remove`
to remove that label; priority is recalculated by the ranker. This is an explicit
operator input, not a listening statistic.
Dispatch reserves a host and leases its work atomically, removing worker races
over the same request slot. Apple lookups combine up to five albums/artists or
50 songs per request without mixing kinds/storefronts. Existing records and
relationships are loaded per batch; unchanged edges and job priorities are not
rewritten. Request, response, backoff and revision-fencing limits still apply.
Crawler logs include `new_entities` and fetch/parse/store timings; ranker logs
include batch duration, making source delays distinguishable from database
lock waits.
See [parallelism and limits](OPERATIONS.md#parallelism-and-limits).

### Optional Mint bridge

The separate, disabled-by-default bridge exposes only bounded metadata reads
and an authenticated MusicBrainz artist-priority feed. It does not expose the
catalog console or acquire audio. Supply a private, randomly generated
`CATALOG_BRIDGE_TOKEN` of 32–256 printable ASCII characters through the
environment or an untracked `.env`, then start it:

```sh
docker compose --profile bridge up -d bridge
```

It binds `127.0.0.1:8098` by default, separate from the console. Configure Mint
with the matching token and bridge URL. Keep traffic on trusted loopback or use
a private TLS-protected connection; never publish the console or a plaintext
bridge externally. The bridge accepts verified MusicBrainz IDs, not names or
library/user details. An empty or partial catalog is not proof that music does
not exist. Separately containerized deployments can use the opt-in TLS/private
network overlay described in [bridge operations](OPERATIONS.md#optional-mint-bridge).

Mint can also use the separate private consumer connection for catalog search
and optional authenticated demand hints. It may run alongside the bridge with a
different token; neither connection shares database access. See
[connecting Mint](OPERATIONS.md#connecting-mint).

### Higher request rates

The four-second default is configurable, not a hard throughput ceiling.
`SOURCE_INTERVAL_SECONDS` accepts fractional seconds from `0.1` to `3600`.
`SOURCE_INTERVAL_OVERRIDES` independently sets each source, for example:

```dotenv
SOURCE_INTERVAL_SECONDS=4
SOURCE_INTERVAL_OVERRIDES=apple=3,ytmusic=1,deezer=0.5
```

This example permits 20 Apple requests/minute, one YouTube Music request/second
and two Deezer requests/second, **shared across every worker and replica**, not per worker.
Use only rates permitted for your access; these values are tuning examples,
not claims about provider quotas. MusicBrainz's public host retains a minimum
one-second interval; Discogs retains 2.5 seconds and Openwhyd 2 seconds.
HTTP `Retry-After`, host backoff and source pauses always win.
Defaults remain unchanged until you configure them. Apply code and settings:

```sh
docker compose up --build -d
docker compose logs --tail=50 crawler
```

Startup logs report effective per-source intervals. Short redirect continuations
now wait for their next slot without repeatedly fetching the original URL.
YouTube Music jobs defer immediately if their first request cannot start, freeing
workers for other sources rather than making all workers wait for the same host.
Already-issued library subrequests still observe shared pacing.

## Stop / restart

```sh
docker compose down            # Stops services; keeps catalog and model volumes.
docker compose up -d           # Starts again with the same stored data.
```

The console binds only to this machine. Do not expose it publicly: it has local
operator controls, not user authentication. For advanced setup, backups, imports,
API details, source limits and development checks, see [OPERATIONS.md](OPERATIONS.md).
