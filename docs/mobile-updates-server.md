# Self-hosted signed mobile updates

Mint's Next.js server implements the [Expo Updates v1 protocol](https://docs.expo.dev/technical-specs/expo-updates-1/)
without EAS hosting or an Expo account. GitHub Actions exports JavaScript/assets,
signs the manifest, uploads assets, then publishes the manifest last. Native
changes require a new APK/runtime. See [mobile setup](mobile.md) and the
[Android build guide](android-builds.md) for build/publisher configuration.

This is executable application code, not a music download. The public web
container needs its **own persistent writable OTA volume**, never a music
mount, worker credentials or private signing key. Server implementation and
fixture verification do not establish physical-device OTA behavior.

## Operator configuration

Configure these server-only variables and recreate the web container:

| Variable | Value |
| --- | --- |
| `PUBLIC_URL` | Public root HTTPS origin, for example `https://mint.example.com` |
| `OTA_STORAGE_DIR` | Absolute dedicated volume path, for example `/var/lib/mint/updates` |
| `OTA_PUBLISH_TOKEN_SHA256` | Lowercase hexadecimal SHA256 of a random publisher token with at least 32 bytes |
| `OTA_SIGNING_CERTIFICATES` | JSON object mapping signing key IDs to public PEM X509 certificates, e.g. `{"main":"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n"}` |
| `OTA_MAX_STORAGE_BYTES` | Optional total stored-file budget; default 1073741824 bytes (1 GiB), maximum 107374182400 bytes (100 GiB) |

Generate the signing key/certificate using the
[Expo code-signing instructions](https://docs.expo.dev/eas-update/code-signing/).
Keep private keys outside the checkout and in protected GitHub Actions secrets.
Only the self-signed RSA public certificate (2048 bits minimum) belongs in the
server trust map and APK. Certificates must explicitly include X509 Key Usage
**Digital Signature** and Extended Key Usage **Code Signing**, as required by
the SDK 58 Android verifier. Expo's generator includes these. For disposable
OpenSSL fixtures use `-addext keyUsage=digitalSignature` and
`-addext extendedKeyUsage=codeSigning`; a generic TLS certificate is not enough.
Certificate validity is checked at publication/read.
The publisher token is a separate Actions secret; the server stores only its
SHA256 hash and compares fixed-length hashes in constant time. Neither secret
belongs in `EXPO_PUBLIC_*`, app assets, browser code or API responses.

The APK must embed `updates.codeSigningCertificate` and
`updates.codeSigningMetadata = {"keyid":"main","alg":"rsa-v1_5-sha256"}`.
Set `updates.url` to `https://mint.example.com/api/updates` and
`updates.requestHeaders` to `{"expo-channel-name":"production"}` (or `preview`).
The runtime fingerprint must include the certificate and all native inputs.
Keep Expo's embedded launch/known-good recovery enabled; an unavailable server
or unknown runtime is not permission to launch an incompatible update.

The server requires persistent local/POSIX storage with atomic same-directory
rename and a single shared publication lock. Do not use ephemeral/serverless
filesystem storage, separate replica volumes or object-store mounts. Configure
the reverse proxy to forward `/api/updates/**` unchanged, without browser login
redirects, and permit PUT/POST uploads up to 64 MiB plus HTTP overhead. Proxy
timeouts must allow an upload (server maximum 120 seconds). TLS and protected
Actions environments/branch rules remain operator responsibilities.

## Publication contract

1. `PUT /api/updates/publish/assets/<sha256-hex>`: raw asset bytes, exact
   `Content-Type` matching the manifest, and `Authorization: Bearer <token>`.
   SHA256 is lowercase hexadecimal in the URL. Body limit: 64 MiB. MIME values
   are lowercase type/subtype without parameters; fonts, images, JavaScript and
   generic binary MIME types are supported.
2. `POST /api/updates/publish`: `application/json`, same bearer header. Body:
   `{"channel":"production","platform":"android","keyid":"main","manifest":"<exact JSON text>","signature":"<base64>"}`.
   The signature is RSA PKCS1-v1.5 SHA256 over the **exact UTF8 manifest bytes**.
   The envelope limit is 1 MiB, including escaping of the manifest string.

The manifest follows the official shape: UUID `id`, ISO8601 `createdAt`,
`runtimeVersion`, `launchAsset`, `assets`, string-valued `metadata`, and `extra`.
`metadata.channel` and `metadata.platform` must match the envelope. Channels
are `production`/`preview`; platforms are `android`/`ios`; runtime strings are
1-128 ASCII letters/digits/dots/underscores/hyphens. Launch MIME is
`application/javascript`. At most 512 additional assets are allowed. Keys must
be unique; preserve the Expo export's asset keys, not SHA256 replacements.

Every asset needs a canonical base64url SHA256 `hash`, `key`, `contentType`,
dot-prefixed `fileExtension`, and an exact URL:
`PUBLIC_URL + /api/updates/assets/<sha256-hex>`. External origins, query strings,
path traversal, noncanonical hashes and MIME disagreements are rejected.
Asset bytes/hash/MIME are verified before activation; signatures and scope
association are verified before any manifest is stored. All retained uploads
and versions count toward the byte budget and a maximum of 10,000 stored files.
There is no automatic eviction of assets referenced by old releases.

The launch asset's extension may be omitted. Every non-launch asset must have
an extension from the Expo export: the installed SDK 58 Android implementation
otherwise drops that asset while parsing, even though the protocol permits an
omitted extension. The server enforces the actual client requirement.

Successful new upload/publication returns `201`; identical retry returns `200`.
An immutable UUID cannot change. Publication creation time must be newer than
the active scoped release and no more than five minutes ahead of server time.
A failed or partial publication never changes the active scope.

## Consumer protocol and errors

`GET`/`HEAD /api/updates` requires `expo-protocol-version: 1`,
`expo-platform`, `expo-runtime-version`, and `expo-channel-name`. JSON responses
support `Accept: application/expo+json` or `application/json`; a client asking
only for multipart receives 406. Mint does not emit rollback directives or
unsigned no-op responses. It always serves the active signed manifest, even
when the client already has that ID; Expo performs the local update check.

Responses preserve the exact signed JSON bytes and include:
`expo-protocol-version: 1`, `expo-sfv-version: 0`,
`expo-signature: sig="<base64>", keyid="main", alg="rsa-v1_5-sha256"`,
channel/platform SFV manifest filters and empty server-defined headers.
Manifests/errors are not cached. Requested signing-key/algorithm mismatches
return 406. No runtime/platform/channel match returns 404, never another runtime
or an unsigned fallback. Existing embedded/known-good app launch remains the
client's responsibility; do not disable recovery to mask an error.

`GET`/`HEAD /api/updates/assets/<sha256-hex>` serves verified immutable bytes
with their stored MIME, length and one-year immutable cache header. Asset routes
carry no credentials; never include publisher secrets in URLs or manifests.
Browser publication is rejected, and these routes do not change normal web or
native facade CORS/CSRF rules.

| Status | Meaning |
| --- | --- |
| 400 | Invalid scope/manifest/hash/body or MIME disagreement |
| 401 / 403 | Missing publisher auth / forbidden browser write or invalid signature/certificate |
| 404 | Missing asset or no release for exact runtime/platform/channel |
| 406 / 415 | Unsupported protocol/Accept/signing expectation or upload content type |
| 408 / 413 | Upload deadline / body-size limit exceeded |
| 409 | Publication lock busy, immutable conflict or non-increasing release time; only lock-busy writes should automatically retry |
| 503 / 507 | Disabled/invalid configuration/storage failure / storage quota reached |

Errors are JSON with `error` text and `Cache-Control: no-store`. Unexpected
filesystem failures are logged server-side without returning paths or secrets.

## Rollback, rotation and storage recovery

To roll back, re-export or retain the known-good bundle/asset metadata, keep its
asset bytes/keys/hashes, and publish a **new UUID, newer creation time and new
signature** for the same runtime/channel/platform. Existing assets are reused;
old UUIDs are never edited or reactivated. This allows Expo's creation-time
selection to actually choose the rollback. Keep build artifacts needed to
produce a known-good signed rollback; do not assume an older Actions artifact
has indefinite retention.

Rotate the publisher token by updating its Actions secret and corresponding
server hash. Rotate signing keys with a new certificate/keyid and a **new native
runtime/APK**. Keep old public certificates in the server trust map while old
APKs still receive updates; publish each runtime with its corresponding private
key. A certificate-only server change cannot update an APK's pinned trust root.
Plan rotation before expiration. Revoke a compromised key's trust and replace
affected APKs; a token alone cannot sign an update.

Storage layout is `assets/<sha256-hex>` (MIME JSON header line plus raw bytes),
`releases/<UUID>.json` (signed publication envelope), and
`scopes/<sha256-of-channel-platform-runtime>.json` (active UUID).
Do not serve the volume as a static directory. Publication uses a shared
`.publish-lock` directory, durable temporary-file writes and atomic renames;
reads continue to see the previous complete release while writes run.

After a publisher process/container crash, **stop every web replica**, back up
the OTA volume, inspect incomplete `.tmp` files, and remove only those exact
temporary files and the stale empty `.publish-lock` directory. Restart and
retry the identical publication. A durable release whose scope activation was
interrupted can be completed by that retry. Never remove a live lock or use
automatic age-based unlocking: it could permit simultaneous writers.

At quota, raise the bounded budget with enough disk space or add capacity.
For unreferenced failed uploads, stop all writers and compute the union of
asset hashes in **every retained release**, not just active scopes; only
unreferenced uploads/temporary files can be removed safely. Do not prune
retained-release assets: older installed clients may still request them, and
the protocol requires immutable assets to remain available. Retiring an entire
old runtime/storage requires an explicit operator support decision and backup,
not routine cleanup. Do not delete music, account data or another volume.

## Verification

```bash
npm exec -w @mint/web -- tsx --test tests/ota-updates.test.ts
npm run typecheck -w @mint/web
npm exec -w @mint/web -- eslint src/lib/ota-updates.ts src/app/api/updates tests/ota-updates.test.ts
```

Tests use temporary isolated storage and disposable RSA certificates generated
with local OpenSSL; no production database, server, account or signing secrets
are used. They exercise valid signed publication/download, exact signatures,
HEAD/MIME/cache behavior, rejected writes/tampering/partial assets/traversal,
scope isolation, quotas, concurrent locks and signed forward-time rollback.
An actual signed APK on the intended Android device is still required to
verify cold launch, update installation, offline launch and native recovery.
