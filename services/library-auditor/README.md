# Mint Library Auditor

A standalone, read-only **metadata quality audit service**. It finds incomplete
tags, repeated recording IDs, claimed identical files and possible duplicates.
It can ask the standalone catalog for evidence-backed recording matches.

**No Mint integration, database access, filesystem scanning, audio reading,
tag writing, deletion or acquisition.** Inputs are metadata manifests supplied
by the operator, not uploaded music. This complements existing library indexing;
it does not replace playback, Plex, acquisition or Mint's recommendation engine.

## Run

```sh
cd services/library-auditor
docker compose up --build -d
curl --fail http://localhost:8098/healthz
```

The HTTP service binds to loopback only. Its container runs nonroot with a
read-only root filesystem, a 512 MiB memory limit and no data mounts. Reports are returned to callers;
the service stores no manifests, reports or listening history.
Do not expose it publicly: it has no authentication.

Submit an audit:

```sh
curl --fail-with-body http://localhost:8098/v1/audits \
  -H 'Content-Type: application/json' \
  -d '{
    "tracks": [
      {"id":"local-1","title":"Northern Lights","artist":"Example Artist",
       "album":"Fixture Album","duration_ms":180000,"track_number":1},
      {"id":"local-2","title":"Northern Lights","artist":"Example Artist",
       "album":"Fixture Album","duration_ms":180500,"track_number":1},
      {"id":"local-3","title":"Missing Tags"}
    ]
  }'
```

Manifest fields: `tracks`, optional `reconcile` (default false) and
`max_findings` (default 200). Each track requires a unique, opaque `id`; optional
fields are `title`, `artist`, `album`, `duration_ms`, `track_number`,
`recording_mbid` and `sha256` (whole-file SHA-256 supplied by the caller).
Unknown fields and invalid identifiers are errors, not silently ignored.
No field is interpreted as a filesystem path or URL.

`findings_total` and `findings_by_code` count **all** findings in the submitted
manifest. `findings` is capped by `max_findings`; `findings_truncated` makes
that explicit. Reviewable issues appear before informational findings, then
sort deterministically by code and track ID. `automatic_actions` is always empty.
The OpenAPI contract is available at `/openapi.json`.

## Optional catalog reconciliation

Start the standalone catalog first. Then, from this directory:

```sh
docker compose -f compose.yml -f compose.catalog.yml up --build -d
```

The optional overlay joins only the catalog's existing egress network and uses
its read-only `/v1/reconcile/recordings` HTTP contract. It mounts neither catalog
nor Mint databases or files. If the catalog project has a different network
name, set `CATALOG_NETWORK`. The client sets the catalog's supported loopback
Host header, does not follow redirects, uses no upstream credentials and ignores
proxy environment variables. Only enable this connection to an operator-trusted
catalog; manifests may contain private library metadata.

Set `"reconcile": true` in a request to opt in. A configuration alone never
sends manifests. At most 100 tracks are allowed in such a request, with four
concurrent lookups and a 30-second overall deadline. Missing title/artist and
recording ID produce an explicit insufficient-metadata finding.

The catalog returns `identified`, `ambiguous`, `candidates` or `no_match`.
Its source URLs, evidence, conflicts and observation times remain in the audit.
An exact name match remains a review candidate, never a proven identity.
A claimed MBID with conflicting duration/title/artist remains ambiguous.
`no_match` describes **catalog coverage**, not whether a recording exists.
Catalog failures or incompatible responses fail the audit with HTTP 502;
no partial report is mislabeled complete. The caller can request a separate
offline audit explicitly.

## What findings mean

| Code | Meaning |
| --- | --- |
| `metadata_gaps` | Missing title, artist, album, duration or track number; not proof that every field is required for every item |
| `identical_content_claim` | Caller supplied the same whole-file SHA-256; the auditor has not read or verified the files |
| `repeated_recording_identifier` | Same claimed MBID appears more than once; intentional compilation/release copies are possible |
| `recording_identifier_conflict` | One claimed MBID has different normalized title/artist or a duration span over two seconds |
| `possible_metadata_duplicate` | Same normalized title, artist and album; all durations within a two-second span; not proof of duplicate audio |
| `catalog_match_review` | Catalog found metadata candidates or conflicting identifier evidence |
| `catalog_identifier_match` | Catalog contains the claimed identifier/evidence; not an acoustic verification |
| `catalog_no_match` | No candidate in the current bounded catalog search |

Normalization folds case, accents, punctuation and whitespace, but retains
version words such as live/remix. Different artists, albums and versions are
not collapsed by the duplicate detector. Duration grouping uses a **maximum
two-second group span**, not transitive pairwise chaining.
Confidence labels describe evidence types, not calibrated probabilities.

## Bounds and CLI

A request contains at most 5,000 tracks and 8 MiB of JSON. Reports contain at most
1,000 findings; use `max_findings` within that range. Duplicates are evaluated
only within the supplied manifest, **not across separate requests**. There is
no assertion that separately audited batches cover an entire library.
Two audits execute concurrently; excess work returns 503. Request-body reading
times out after ten seconds. Catalog responses are capped at 256 KiB per lookup.

For private, persistent output, run the CLI and redirect the result to your
own location:

```sh
python -m venv .venv
.venv/bin/pip install -e '.[test]'
.venv/bin/mint-library-auditor audit /absolute/path/to/manifest.json > report.json
# If the manifest explicitly requests reconciliation:
.venv/bin/mint-library-auditor audit /absolute/path/to/manifest.json \
  --catalog-url http://127.0.0.1:8097 > report.json
```

The CLI returns nonzero on invalid input or dependency failure; it never
modifies the manifest. Keep real manifests and reports outside the repository
(or in the ignored `reports/` directory). No telemetry is sent.

## Validate

```sh
.venv/bin/python -m pytest tests -q
.venv/bin/python -m ruff check auditor tests
docker compose config --quiet
docker compose -f compose.yml -f compose.catalog.yml config --quiet
```

Tests use fictional metadata and mock HTTP. Actual-library coverage and
acoustic duplicate accuracy require separate, authorized evidence.
