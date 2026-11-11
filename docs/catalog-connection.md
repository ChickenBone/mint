# Optional standalone catalog connection

Mint works without the standalone catalog. An optional metadata-only connection
adds catalog albums and their recording lists alongside the existing playable
library. Catalog recordings are not player items, queue entries or downloaded
files. Only **Add to library** uses Mint's existing explicit, account-bound
recording request flow; browsing never starts acquisition.
Artist catalog shelves require ready verified artist metadata. Existing local
album views can show catalog recordings only when their indexed playable tracks
have one unambiguous explicit MusicBrainz release-group ID. Names/titles alone
never connect a local album to the standalone catalog.

## Private connection

Set `CATALOG_BRIDGE_URL` and `CATALOG_BRIDGE_TOKEN` in the Mint **web and worker**
server environments. Leave both absent to disable the connection. The token must
match the standalone catalog bridge token and contain 32-256 printable
non-space ASCII characters. Do not put it in client/native configuration, a URL,
logs or a public repository. Use a bridge-only endpoint, never the catalog console.
Alternatively, set `CATALOG_BRIDGE_TOKEN_FILE` to a private token file readable
by those server processes instead of setting the token directly. Never place the
token in the root shared `.env`: other services inherit that file.

HTTPS is required except for literal loopback HTTP (`localhost`, `127.0.0.1`,
`[::1]`) when both processes run on the same trusted host. URLs must have no
embedded credentials, query, fragment or path prefix. Redirects are rejected.
Do not expose a plaintext bearer endpoint on a public or LAN network or disable
TLS certificate verification.

For separate Docker stacks, use the catalog owner's TLS private-network overlay
and Mint's [network overlay](../deploy/docker/catalog-network.yml). The operator
creates an **internal** external network named `mint-catalog-bridge` (or sets
`CATALOG_BRIDGE_NETWORK` consistently in both stacks). Only Mint web/worker and
the catalog bridge join it; the console is not exposed. The bridge has network
alias `mint-catalog-bridge`, listens with TLS on port 8080 and needs a certificate
with DNS SAN `mint-catalog-bridge`. Set `CATALOG_BRIDGE_CA_FILE` to a readable PEM
issuing-CA file on the Mint host, and configure the matching bridge certificate,
key and bearer token in the separate catalog stack. Mint mounts only the CA,
not the bridge's private key.
Set the host `CATALOG_BRIDGE_TOKEN_FILE` Compose variable to a private file
containing the shared token. The overlay grants that secret only to web/worker;
Compose configuration contains its file reference, not its contents.

Use the overlay **after** the root Compose file; Compose merges its network
membership with the existing edge/data/media memberships:

```sh
docker network create --internal mint-catalog-bridge
docker compose -f docker-compose.yml -f deploy/docker/catalog-network.yml config --quiet
docker compose -f docker-compose.yml -f deploy/docker/catalog-network.yml up -d
```

These commands describe operator setup, not an instruction to deploy from an
agent session. Keep filled environment files private. The overlay sets
`NODE_EXTRA_CA_CERTS=/catalog-ca/ca.pem`; Node verifies the endpoint certificate
normally. A split-host deployment instead needs an operator-controlled private
TLS network/proxy and trusted CA; changing the URL alone does not establish
reachability. The overlay is for the root containerized web/worker stack, not
hosted Vercel. Do not attach public proxy, hub or realtime services to it.

## Identity, population and failures

The worker's existing periodic artist-metadata maintenance automatically sends
verified MusicBrainz artist IDs for indexed existing-library artists. Ready
artist metadata must supply an explicit canonical UUID and agree with any
existing track artist IDs; conflicting identities are excluded. No artist names,
account data, media paths or library contents are sent. Popularity and wider
discovery remain the standalone catalog's responsibility, not an exclusive
library-only policy.

Each tick sends at most 50 additions and 50 explicit removals. Redis persists
keyset cursors and acknowledged IDs across restarts, so larger libraries progress
beyond the first batch. Failed requests do not advance cursors or clear priorities.
Metadata refresh/failure alone retains an already acknowledged identity; removal
requires a missing library artist or a confirmed invalid/changed identity.
Use one Mint installation per bridge priority provenance: the catalog's
`mint-library` feed is not namespaced for multiple independent installations.
Keep the same endpoint/credential for reconciliation; changing them starts a new
feed state, and old priorities require explicit operator reconciliation.

Reads use authenticated `/v1/artists/{artist_mbid}/albums` and
`/v1/albums/{release_group_mbid}/recordings` with at most 100 entries per page.
Only canonical MusicBrainz IDs and matching source URLs are accepted. Native
and cookie-web consumer facades expose private/no-store metadata and fresh
account-bound request tokens, never the bridge credential. Pages are current
keyset reads, not a frozen queue or a guaranteed complete release track order.

The server bounds upstream reads to five seconds and 1 MB, and rate-limits
consumer paging. Unconfigured Mint retains its existing library behavior.
Unavailable/invalid upstream responses show a retryable catalog error without
removing playable library songs. A catalog album with no populated recordings
is an honest empty state, not proof of completed catalog enrichment. Actual
reachability, library identity coverage, catalog population and native device
behavior require deployment/device evidence.
