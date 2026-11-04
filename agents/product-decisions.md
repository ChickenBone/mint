# Product decisions and evolution

## What Mint is

Mint is a self-hosted music service: local files, a Plex-backed shared library, personal collections and discovery in Mint's own browser player. Docker Compose is the primary deployment path; prebuilt multi-architecture images are published to GHCR through GitHub Actions.

There are three audiences:

- **Public visitors:** browse library metadata, artwork, chart availability and public activity; request an account.
- **Approved members:** listen, manage personal collections, link providers and explicitly request missing music.
- **Operators/admins:** approve access, manage jobs/workers, inspect integration health and control analysis.

An account request is not playback approval. A member can listen to existing music without linking Google or Spotify. Separate Plex invitations are needed only for external Plex clients.

## Durable requirements

- Keep files on the host server and preserve existing music read-only.
- Make listening cohesive and reliable without exposing private media services.
- Support massive libraries through bounded discovery, tolerant search and progressive queues.
- Keep acquisition and analysis progress observable, including failures and recovery actions.
- Retain YouTube Music synchronization; support Spotify playlists as metadata matched to local music.
- Keep all current listening, organization, offline and management capabilities during redesigns.
- Make self-hosting understandable for people using NAS project editors, not only shell users.
- Keep optional providers, remote download workers and separate analysis machines genuinely optional.

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

Historical requests for proprietary Plexamp features do **not** authorize entitlement bypasses, pretending Plex Pass is enabled or labeling independent algorithms as Plexamp technology. The current decision is an independent Mint implementation with truthful capability/fallback states.

Public audio previews were removed. Do not restore public 30-second streaming because it appeared in an early brief.

## Preserved scope versus future work

Preserve editable/smart/collaborative playlists, source-managed imports, private history, radios/mixes, lyrics corrections, DSP, device control, explicit handoff, single-output parties and account-scoped offline downloads.

Do not promise DJ-grade beat/phrase mixing, pitch-preserving tempo sync, synchronized multi-device audio, a native Android background service, Android Auto, neural similarity or exact gapless playback. These were deferred or remain outside verified browser guarantees.

See [PRODUCT.md](../PRODUCT.md) for detailed scope and [README.md](../README.md) for supported setup paths.
