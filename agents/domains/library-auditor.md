# Standalone library quality auditor (`library-auditor`)

## Boundaries

- Owns `services/library-auditor/**`: independent Python package, HTTP API, CLI
  and Docker service. Read its README before implementation.
- No Mint imports, databases, accounts, playback, recommendations or acquisition.
  Do not scan/read music, write tags, delete files or mount original libraries.
- The catalog is optional and consumed only through its read-only
  `/v1/reconcile/recordings` contract; no cross-domain Python imports.

## Invariants

- Audits operate on bounded, caller-supplied metadata manifests with unique IDs.
  No field becomes a filesystem path or network target.
- Hash equality is a caller-supplied claim, not verified audio identity.
  Repeated recording IDs may be intentional across releases; metadata similarity
  is review evidence, never authority for a merge or deletion.
- Preserve artist/version distinctions and nontransitive duration grouping.
  Evidence categories are not calibrated confidence percentages.
- Findings have deterministic ordering, exact totals and explicit truncation.
  Reports say whether files were read/modified; automatic actions remain empty.
- Catalog calls require both operator configuration and per-request opt-in.
  Retain source provenance and ambiguity. Failures are explicit, not empty
  successful reports. No credentials, redirects or user-controlled target URLs.
- Container binds loopback, runs nonroot/read-only and stores no submitted
  metadata. Keep real manifests/reports out of this public repository.
- Requests are independent: duplicate coverage never extends across batches
  without an explicitly implemented and documented persistence design.

## Validation

Install this service's `.[test]` extras into an isolated environment. Unit/API
tests use fictional manifests and mock HTTP; separately verify container
startup and the optional real catalog HTTP connection before claiming deployment.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Read-only metadata manifest audits for duplicates, identifier conflicts and tag gaps with optional catalog matching.
- **Read before editing:** [services/library-auditor/README.md](../../services/library-auditor/README.md).
- **Imports from:** none
- **Imported by:** none
- **Live detail:** `npm run agents -- map library-auditor` (exports, line counts, cross-domain import edges).

### Owned files (16)

- `services/library-auditor/` `.dockerignore`, `.gitignore`, `Dockerfile`, `README.md`, `compose.catalog.yml`, `compose.yml`, `pyproject.toml`
- `services/library-auditor/auditor/` `__init__.py`, `api.py`, `audit.py`, `catalog.py`, `main.py`, `model.py`
- `services/library-auditor/tests/` `test_api.py`, `test_audit.py`, `test_cli.py`

### Validate

No owned automated tests; add focused tests with behavior changes.

```bash
python -m pytest services/library-auditor/tests
python -m ruff check services/library-auditor
docker compose -f services/library-auditor/compose.yml config --quiet
docker compose -f services/library-auditor/compose.yml -f services/library-auditor/compose.catalog.yml config --quiet
```

<!-- agents:generated:end -->
