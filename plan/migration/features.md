# Feature preservation and retirement matrix

The combined API retains Mint and donor capabilities; initial delivery is the
new `@mint/sdk` and existing Next.js web UI. Both Expo apps remain untouched, and
remote worker execution is explicitly deferred. No other listener or
provider-import capability retirement is authorized.
The follow-up explicitly prefers retiring Plex dependencies/external integration
and replacing Redis/BullMQ infrastructure after responsibility-equivalence gates.
**Preserve/rebuild** means new internals with unchanged intended capability;
**adapt** means use donor patterns behind Mint contracts. Donor gaps reflect
the inspected [source revision](../research/baselines.md), not permanent limits.

| Capability | Decision | Target and done evidence |
| --- | --- | --- |
| Native Home/Search/Library and persistent player | Leave both Expo apps and existing `@mint/client` untouched | Inventory API capabilities; defer mobile client wiring and device acceptance; do not claim parity with the new web SDK |
| Browser public/listening routes and admin | Rewire the preserved Next.js UI through the new `@mint/sdk`, except anonymous public library browsing | Remove public `/browse` and its entry links without a redirect or compatibility handler (D36); keep other public routes and admin. Start P1's end-to-end slice with approved-member `/app/library` listing/search. Preserve playback/collection controls and move only their necessary target backend dependencies forward for UI integration (D40); broader APIs stay in P4. Keep this SDK separate from Expo's existing `@mint/client` (D42). Do not defer to preserve old-backend runtime continuity or treat placeholders as working actions; see [D32-D42 and the remaining gates](../execution/decisions.md#decisions) |
| Accounts/approval/browser/native sessions | Preserve/rebuild | D33 moves only the required account/session/approval prerequisite into P1; other account/runtime work stays in P2. D34-D35 preserve active member/admin access, approval and account/session fields, Argon2 and target-owned opaque PostgreSQL-backed cookie sessions with a 30-day lifetime. D37 keeps `mint_session`: the same-origin Next.js gateway forwards only its opaque token to the private API, which independently resolves the principal from PostgreSQL on every request, checking expiry, revocation and account status without trusting client or Next identity headers. Preserve hashed token storage, HttpOnly, secure and SameSite cookies and origin protections. Reject native `mn1.` tokens as browser credentials; retain native role restriction, cookie/bearer isolation and active-account checks. The exact gateway/API interface remains open, not implemented by this decision; do not infer JWT, legacy migration or a temporary auth adapter |
| Local library and originals | Preserve/rebuild; retire Plex target dependency | Direct Mint-owned read-only inventory/probes/art/delivery, stable aliases, edition matches and accepted upgrade precedence |
| Playlists/likes/smart/collaborative/folders/invitations | Preserve/rebuild | Occurrences/revisions, permissions and complete bounded traversal |
| YouTube/Spotify/provider-managed imports | Preserve/rebuild | Provider ownership/sync/aliases retained; source-specific duplicate semantics explicit |
| Search/catalog/browse/charts | Preserve metadata catalog/backend capabilities; retire anonymous public library browsing | Keep member library/catalog search and future metadata browse/search, explicit unavailable-catalog state, scoped charts and no browse acquisition. Do not treat public `/browse` retirement as removing backend catalog operations |
| Standalone metadata bulk/seed/crawl/index | Reimplement in TypeScript/PostgreSQL/pgvector | Preserve bulk checkpoints/fairness/provenance/revision fencing; automatic bounded seeding, on-demand enrichment and optional bulk |
| Discovery/radios/mixes/history/privacy | Preserve; adapt ranking | Private account inputs, cold-start honesty and reproducible bounded ranking |
| Source-specific acquisition and management | Preserve Mint behavior; adapt durable intent/fencing | Explicit requests and YouTube sync enqueue; Spotify metadata-only matching; conservative sources/reuse and original protection |
| Server queues/progressive shuffle | Preserve/rebuild | Full-selection identity/order, duplicate occurrences, revision conflicts and paused restoration |
| Audio/range/transcoding | Preserve/rebuild | Private grant purpose, revocation, confined paths, HEAD/Range and working compatibility codec |
| Offline | Preserve/rebuild | Account/server scope, renewal/expiry, budgets, cancellation/logout cleanup; device proof |
| Lyrics/corrections/artwork | Preserve; adapt provenance/sidecars; replace Plex artwork | Bounded providers, timing preference, embedded/sidecar/licensed assets, private/public separation and safe fallback |
| Analysis/DSP/Smart Fades | Preserve/rebuild implemented surfaces | Measured engine versions/remote leases; do not infer native parity |
| Devices/handoff/parties | Preserve/rebuild | Destination acknowledgement before source pause, single-output behavior and command recovery |
| Volunteer/remote analysis workers | Defer execution initially | Keep capability inventory/contracts; initial deployment runs local workers only |
| Compose/NAS/EAS distribution | Fresh local-worker deployment; Expo distribution untouched | Private networking, optional providers and coherent backup/restore; no legacy state migration |
| Agent routing/context | Preserve; adapt package enforcement | One owner per file, bounded prompts, real dependency checks and focused validation |
| Plex service/client mirrors | User prefers retirement in target | Replace Mint library/media/art/finalization/import responsibilities; external Plex clients are not target compatibility |
| Redis/BullMQ infrastructure | User prefers PostgreSQL/pg-boss consolidation | Preserve queue, event, cache, throttle/admission and status behavior through explicit equivalents |
| Embedded Plexamp/public previews/self-hosted OTA | Remain retired | Do not restore historical superseded functionality |

Before implementation, expand each row into an operation/data/test inventory in
its owning domain. Caps and timing budgets come from current schemas/helpers;
changing them requires an explicit product decision, not silent donor defaults.
Deferred commercial-service ambitions are not implemented parity obligations;
see [current product decisions](../../agents/product-decisions.md).

## Donor runtime availability is not parity

Native offline is explicitly unsupported; browser encrypted offline with an
ordinary short stream grant is not a durable native entitlement. Transcode
infrastructure exists but built-in authorization is disabled/original-only.
Local lyric sidecars work; licensed fallback providers are injectable but not
configured. Default recommendations lack live account-history input. Provider
playlist/Spotify OAuth/YouTube sync and Mint server occurrence queues,
analysis/DSP/device lifecycles have no established donor replacement.

Playlist summaries are cursor-paged but detail caps at 1,000; provider artist/
album detail caps at 100 without continuation. Existing Mint limits/semantics
must not silently become those donor defaults. UI long-scroll tests prove only
the tested rows, not full provider/API coverage.

Plex-free Spotify matching must use verified media availability rather than the
current Plex-key eligibility predicate. Normal Mint streaming/transcoding and
measured analysis are already independent; preserve them rather than inventing
unnecessary replacements. Retire only external Plex mirrors/invitations and
Plex-specific sonic/setup/status surfaces. Fresh installs require no old-client
compatibility or imported Plex/account state.

Donor direct scanning is not a complete recurring Plex replacement: completed
root cursors do not reset, deletion/rename/mount-loss reconciliation is absent,
and active scanned originals do not persist all rich technical probe results.
Untagged attribution and embedded cover extraction need target work. These are
acceptance requirements, not reasons to retain Plex in the final target.
