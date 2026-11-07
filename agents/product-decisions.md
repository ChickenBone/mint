# Product decisions and evolution

## What Mint is

Mint is a self-hosted music service: local files, a Plex-backed shared library, personal collections and discovery. The Expo Android/mobile app is the consumer UX/UI design authority. Browser consumer UX is frozen, maintenance-only; preserve existing listening/routes while maintaining security, Next.js backend/API compatibility and administration. Docker Compose deploys the backend; GitHub Actions publishes multi-architecture images to GHCR.

There are three audiences:

- **Public visitors:** browse library metadata, artwork, chart availability and public activity; request an account.
- **Approved members:** listen, manage personal collections, optionally import playlists and explicitly request missing music.
- **Operators/admins:** approve access, manage jobs/workers, inspect integration health and control analysis.

An account request is not playback approval. A member can listen to existing music without linking Google or Spotify. Separate Plex invitations are needed only for external Plex clients.

## Durable requirements

- Keep files on the host server and preserve existing music read-only.
- Make listening cohesive and reliable without exposing private media services.
- Support massive libraries through bounded discovery, tolerant search and progressive queues.
- Keep acquisition and analysis progress observable, including failures and recovery actions.
- Preserve existing provider data and integrations, but do not organize the listener experience around provider sync. Keep YouTube playlist import available; provider-managed data must not be silently deleted or misrepresented as editable.
- Keep all current listening, organization, offline and management capabilities during redesigns.
- Make self-hosting understandable for people using NAS project editors, not only shell users.
- Keep optional providers, remote download workers and separate analysis machines genuinely optional.
- Base future listener work on native mobile decisions: independently implemented Spotify-inspired controls/gestures and dynamic artwork-derived gradients, readable neutral fallbacks and accessible alternatives. Do not start a parallel browser redesign or claim proprietary assets/feature parity.
- Cache reads within explicit freshness, stale, retry, size and privacy budgets; never share account-specific data or reuse revoked authorization. Developer diagnostics are opt-in, local-only and truthful about available measurements; no automatic uploads or telemetry.

## Decision history

| Stage | Decision and current interpretation |
| --- | --- |
| Initial platform | Accounts, public library/activity, synchronization, acquisition, private media services, Docker and CI/CD established the foundation. The implemented music manager is Lidarr; early mentions of Radarr/Sonarr are not requirements to add video managers. |
| Split deployment exploration | Vercel frontend plus home media services was explored. All-in-one Compose remains the recommended complete listening deployment; split hosting needs separately validated private gateway connectivity. |
| Early listening versions | An embedded Plexamp integration proved playback but made UX and feature ownership difficult. Its implementation is superseded. |
| Native transition, V3.1 | Remove embedded Plexamp entirely, retaining Plex as library server. Do not restore vendor assets, patched loaders, iframes or compatibility emulation. |
| V3.5 | Preserve native playback while adding measured analysis, Smart Fades, discovery, playlists, devices/parties, lyrics and offline PWA capability. Version labels are history, not proof of current release/image publication. |
| Large-library corrections | Do not render or hydrate entire libraries by default. Full-collection shuffle must remain complete, unique and responsive; ordinary search must tolerate non-exact input. |
| Artwork reliability | Plex is the primary library artwork source; validated free public sources are backup. Private tokens/URLs must not reach browsers. |
| Listening-room redesign | Home, Discover and Library lead. Collections stay nearby; technical operations move into Settings/Management without disappearing. |
| Chart discovery | Real US/country and clearly scoped international/genre charts become virtual collections. Local songs play; missing songs are muted with explicit acquisition. Provider scope must be honest. |
| Consumer-first direction | The listener experience should feel familiar to Spotify and Apple Music users, with standard labels such as "Liked songs" and "Create playlist" rather than repetitive Mint qualifiers. Use Mint branding and independently implemented UI and assets. Administration stays in an admin-only area of the same application. Preserve existing provider data and integrations while moving sync out of the consumer experience. An optional self-hosted MusicBrainz mirror must retain a public fallback. Use supported chart feeds or permitted scraping, not sources that prohibit it. Commercial-service parity is a goal, not a claim of implemented features. |
| Expo consumer surface | Home, Search and Your Library lead in the native app. Search includes data-backed Browse all categories and read-only charts; browsing never acquires music. Explicit recording requests remain separate. The Next.js backend, browser listening and admin-only management retain their features. |
| Native design authority | Supersedes parallel browser UX development: the native app governs future consumer UX/UI, with original Spotify-inspired interactions and artwork-derived dynamic gradients. Browser UX is frozen, maintenance-only, not deleted; Next.js backend/API, security, compatibility and admin tools continue. Local-only developer diagnostics expose actual engine/analysis/cache observations, never invented codec, throughput, waveform or DSP capabilities or telemetry uploads. |
| Android distribution | EAS Build supplies APKs; EAS Update supplies compatible JavaScript/assets. The self-hosted OTA endpoint/volume is retired. Native runtime changes require a new, signer-verified APK; compare with a finished compatible EAS build, not the last commit. EAS quotas apply; publication is not device verification. |

Historical requests for proprietary Plexamp features do **not** authorize entitlement bypasses, pretending Plex Pass is enabled or labeling independent algorithms as Plexamp technology. The current decision is an independent Mint implementation with truthful capability/fallback states.

Public audio previews were removed. Do not restore public 30-second streaming because it appeared in an early brief.

## Preserved scope versus future work

Preserve editable/smart/collaborative playlists, source-managed imports, private history, radios/mixes, lyrics corrections, DSP, device control, explicit handoff, single-output parties and account-scoped offline downloads.

Do not promise DJ-grade beat/phrase mixing, pitch-preserving tempo sync, synchronized multi-device audio, Android Auto, neural similarity or exact gapless playback. Browser background guarantees remain limited. Expo's configured background audio is distinct from the historically deferred custom Android playback/download service; physical-device suspension and lockscreen behavior need device evidence. Browser DSP/Smart Fades support does not imply native feature parity.

See [PRODUCT.md](../PRODUCT.md) for detailed scope and [README.md](../README.md) for supported setup paths.
