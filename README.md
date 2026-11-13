# Mint — self-hosted music streaming with Plex

**Your music library. Your server. Your player.**

Mint is a self-hosted music service for listening, discovering and collecting music from your own library. The Expo Android/mobile app leads the consumer experience with Home, Search and Your Library, familiar Spotify-inspired interactions and artwork-derived color. Native mobile is the design authority for future listener work; browser listening is frozen, maintenance-only. The Next.js backend/API, existing browser routes and admin tools remain supported. Your music files stay on your server; Plex remains the library server, not an embedded player.

Deploy with **Docker Compose** on a NAS or Linux server. Prebuilt images are published to **GitHub Container Registry** for amd64 and arm64. You can connect an existing Plex library read-only or start with the bundled Plex server.

[Get started](#get-started) · [Self-hosting guide](docs/self-hosting.md) · [Screenshots](#screenshots) · [Updating](#updating-and-backups) · [Troubleshooting](#troubleshooting)

![Mint home with personal recommendations, album artwork and a persistent music player](docs/screenshots/home.png)

## What you can do

| Feature | What it means for you |
| --- | --- |
| **Use the Android app** | Consumer-focused Expo app with persistent playback and account-scoped downloads. EAS Build creates installable APKs; EAS Update delivers compatible JavaScript updates. [Setup and downloads](docs/android-builds.md). |
| **Inspect local playback** | Opt-in **Settings → Developer options → Stats for nerds** shows actual engine observations and existing measured analysis in the player, with no telemetry or trace uploads. [What is measured](docs/mobile-playback.md#local-stats-for-nerds). |
| **Keep browser access** | Existing persistent playback, full-collection shuffle, queues, album/artist views and Search remain available, with security and backend-compatibility maintenance rather than new browser UX. No embedded Plexamp required. |
| **Bring your own library** | Index existing Plex music with read-only access to the original files. Keep using Plexamp separately if you prefer. |
| **Make it yours** | Save liked songs and playlists, create smart playlists, collaborate and revisit your private listening history. |
| **Search and discover** | Search your library and more recordings. Native Browse all adds real recommendations, new arrivals, paged genres/moods/decades and read-only charts. Missing music requires an explicit request; browsing never downloads it. |
| **Shape browser listening** | Equalizer, loudness normalization, waveform, Mint Smart Fades, lyrics and personal lyric corrections. Mint's own analysis does not require Plex Pass; this is not a claim of native DSP parity. |
| **Bring existing playlists** | YouTube Music linking and Spotify playlist metadata are optional integrations. Spotify imports play local matches only; they do not stream Spotify audio or automatically download missing songs. [Provider requirements](docs/spotify.md). |
| **Explore real charts** | Keyless Apple Music country Top 50s, ListenBrainz community rankings and Audius trending/genre collections. Play local matches or explicitly request missing recordings; never automatic downloads. [Coverage, providers and setup](docs/charts.md). |
| **Listen across devices** | Control awake browser clients, hand off playback, or share a party queue with one output device. [How devices work](docs/devices.md). |
| **Take music offline** | Install the HTTPS web app from Android Chrome and explicitly download music for offline listening. Browser storage and background limits still apply. |
| **Manage your instance** | Approve member accounts, monitor jobs and services, and optionally add Docker download workers or a separate private-network analysis machine. |

Public visitors can view homepage artwork, charts and library activity or request an account; anonymous library browsing is retired. **Only approved members can stream music or request acquisition.** Plex, Cobalt and acquisition credentials stay behind the private worker.

## Get started

### Before you install

You will need:

- **A Docker host:** a NAS or Linux server with Docker Compose. The command-line stack requires Compose **2.24+**; NAS project editors must support health checks and completed initialization dependencies.
- **An HTTPS hostname:** a domain you control. Choose Cloudflare Tunnel for the NAS template, or direct HTTPS through Caddy for the command-line template. An HTTP LAN address is not a production login URL.
- **Persistent storage:** room for music, PostgreSQL, service configuration and temporary downloads/analysis. CPU, memory and disk needs depend on your library and enabled services; analysis concurrency is adjustable.
- **A Plex library:** use the bundled server with a Plex account, or connect an existing music library with its token, section ID and a read-only filesystem mount.

**Start without extra subscriptions.** Google OAuth is needed only for YouTube Music linking. TorBox and additional indexers are optional acquisition integrations. Spotify needs its own developer app and is subject to Spotify's account/API restrictions. Mint analysis needs neither a GPU nor Plex Pass; Plex's own sonic analysis has separate entitlement requirements.

### Choose your installation

| Your setup | Start here | Public access |
| --- | --- | --- |
| **NAS, UGREEN Docker Projects or Portainer** | [`docker-compose.nas.yml`](docker-compose.nas.yml) | Bundled Cloudflare Tunnel; no Mint router ports to forward |
| **Linux server with a terminal** | [`docker-compose.yml`](docker-compose.yml) | Caddy HTTPS; domain and reachable ports 80/443 required |
| **Existing Plex library** | Either setup, then [read-only library configuration](docs/self-hosting.md#use-an-existing-plex-music-library-read-only) | Your current Plex server remains separate |

These are complete deployments, not just frontend containers. Keep databases, generated secrets and service configurations when updating.

### Android app

The [Expo consumer app](docs/mobile.md) connects to your own Mint HTTPS server
with the same approved account. [EAS Build and EAS Update](docs/android-builds.md)
handle APK builds and OTA delivery; no application-update container or storage
mount is needed on your NAS. Native changes require a new APK, while compatible
JavaScript changes can update through Expo. Expo's free-plan quotas and device
validation limits still apply; EAS does not host your music or Mint backend.

### Option A: NAS or Portainer

1. Copy the **entire** [`docker-compose.nas.yml`](docker-compose.nas.yml) into a new Compose project named `mint`. Choose a permanent project folder.
2. Create a remotely managed Cloudflare Tunnel. Add your hostname with service **`http://caddy:80`**, then set `MINT_DOMAIN` and the tunnel connector's `TUNNEL_TOKEN` in the template's settings block.
3. Pull the images. For a new bundled Plex server, obtain a fresh [Plex claim](https://plex.tv/claim) just before starting Plex; it expires in four minutes. Existing Plex owners should follow the [read-only setup](docs/self-hosting.md#use-an-existing-plex-music-library-read-only) instead.
4. Deploy the project, open the completed `init` container's private logs for your admin login, and sign in at your HTTPS hostname. Open **Admin** for remaining setup steps.

No separate `.env` or source checkout is required. Data is stored under the project's `./data` folders. **Do not move or delete the project folder during updates.**

Read the [full NAS instructions](docs/self-hosting.md#nas-setup-copy-paste-deploy) before deploying, especially if migrating an older installation or connecting existing music.

### Option B: Linux server

Point your domain at the server and make ports 80/443 reachable first.

```bash
mkdir mint && cd mint
curl -fsSLO https://raw.githubusercontent.com/ChickenBone/mint/main/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/ChickenBone/mint/main/.env.example
chmod 600 .env
```

Edit `.env`: set `MINT_DOMAIN` to **your** hostname, then pull the images:

```bash
docker compose pull
```

For the bundled Plex server, get a fresh [claim token](https://plex.tv/claim) and set `PLEX_CLAIM` in `.env` immediately before starting:

```bash
docker compose up -d
docker compose logs init
```

Open `https://<your-hostname>` and sign in with the generated admin credentials. `init` exiting successfully is expected. Caddy handles HTTPS certificates. Keep initialization logs private, and remove the expired claim from `.env` after Plex is claimed; an existing server does not need to be reclaimed on updates.

The [complete guide](docs/self-hosting.md#command-line-setup) explains provider setup, storage and networking. Connecting an existing server? Follow the [command-line Plex override](docs/self-hosting.md#existing-plex-with-the-command-line-stack) before the first `up`.

### Your first session

1. **Open the Admin portal.** Confirm the worker and Plex are reachable. If using existing music, wait for indexing and correct any path-mapping errors before syncing.
2. **Search and explore.** Search indexed albums, songs and external recordings, or browse personalized mixes and charts from the same destination. Linking a provider is not required to listen to existing music; keyless charts need no extra account.
3. **Make it yours.** Like songs, create a playlist and explore your library. Connections such as [YouTube Music](docs/self-hosting.md#google-youtube-music-linking), [Spotify playlists](docs/spotify.md), or [Lidarr + TorBox](docs/self-hosting.md#lidarr--torbox) are optional.
4. **Invite your household.** People request an account on your own hostname; approve them in Admin. A separate Plex library invitation is needed only for external Plex clients.

## Screenshots

### Expo consumer app

Search's Browse all on phone and wide layouts. These are **browser-rendered
Expo with fictional fixture data**, original generated artwork and mock chart
rankings—not physical-device or live-chart proof. Chart titles and counts in
these fixtures do not describe production provider coverage.

<p align="center">
  <img src="docs/screenshots/expo-browse-phone.png" alt="Browser-rendered Expo Search on a phone-sized viewport with fictional Browse all recommendations, charts and decades" width="260">
</p>

![Browser-rendered Expo Search with fictional Browse all categories and wide-screen navigation](docs/screenshots/expo-browse-wide.png)

### Next.js browser listening and management

Browser desktop and responsive-phone views captured from a local demo instance,
not current Expo APK/device screenshots or the design target for future listener
work. Browser consumer UX is frozen; management remains supported.
All names, accounts, songs, artwork and
activity are fictional; no private library or credentials are shown.

| Listening | Running your server |
| --- | --- |
| ![Mint Now playing view with album artwork, playback controls and the upcoming queue](docs/screenshots/now-playing.png) | ![Mint jobs dashboard with matching, downloads and Plex scanning progress](docs/screenshots/jobs.png) |
| **Now playing:** your music, queue and multi-source lyrics. Sound controls live in Settings. | **Jobs:** see what is happening and where a track needs attention. |
| ![Mint's all-music view with songs, album artwork and playback controls](docs/screenshots/library.png) | ![Mint audio analysis coverage, connected workers and full-library processing actions](docs/screenshots/analysis.png) |
| **All music:** browse songs, albums and artists without loading everything at once. | **Audio analysis:** check coverage and queue full-library processing. |
| ![Ranked chart discovery with provider attribution, local playback and explicit Add to library actions](docs/screenshots/charts.png) | ![Listener settings for playback, downloads and connected services](docs/screenshots/settings.png) |
| **Charts:** provider rankings with local playback and song requests. The screenshot uses fictional chart data. | **Settings:** personal playback and account preferences. |
| ![Unified Search with a fictional external recording and an explicit Add to library action](docs/screenshots/search-missing.png) | ![A fictional chart song after an explicit request](docs/screenshots/chart-requested.png) |
| **Search:** browse local matches and add a missing recording only when you choose. | **Requests:** follow a chart song as it becomes available; the demo simulates completion. |

<p align="center">
  <img src="docs/screenshots/mobile-home.png" alt="Mint recommendations and persistent player on a phone" width="260">
  &nbsp;
  <img src="docs/screenshots/mobile-player.png" alt="Mint mobile Now playing screen with album cover and pinned playback controls" width="260">
</p>

<details>
<summary>Public pages, likes, account management and workers</summary>

| Public pages | Member and admin tools |
| --- | --- |
| ![Mint public landing page with an album-art wall and access request button](docs/screenshots/landing.png) | ![Personal liked songs in Mint](docs/screenshots/liked.png) |
| ![Public library statistics and recently added music](docs/screenshots/landing-stats.png) | ![Admin dashboard for approving accounts and monitoring service health](docs/screenshots/admin.png) |
| **Historical screenshot only:** retired anonymous public library page (`/browse` is removed) ![Historical screenshot of the retired public library browse page](docs/screenshots/browse.png) | ![Built-in pipeline worker and optional volunteer download workers](docs/screenshots/workers.png) |

<p align="center">
  <img src="docs/screenshots/mobile-landing.png" alt="Mint's public landing page on a phone" width="260">
</p>

</details>

## How it works

```mermaid
flowchart LR
  files[Music files on your server] --> plex[Plex library]
  plex --> worker
  worker[Private pipeline worker] --> mint[Mint web app]
  charts[Public chart metadata] --> mint
  imports[Optional playlist imports] --> mint
  mint --> listener[Approved members]
  mint --> mobile[Expo consumer app]
```

The public web app does not mount your music or receive your Plex administrator token. It sends authorized audio requests to a private worker, which checks membership and reads the files. Album artwork is public and uses Plex first, with free public sources as backup. Public library metadata is intentionally visible; audio is not.

Downloads try configured Lidarr/TorBox sources first, then Cobalt when an eligible YouTube source is available. Existing-library originals stay read-only; accepted upgrades are stored separately. Recommendations and Spotify imports do not silently acquire music.

**Two optional worker types:** volunteer agents handle downloads over outbound HTTPS; analysis workers measure audio over a separate private/VPN connection. Their credentials and jobs are not interchangeable. [Download workers](docs/self-hosting.md#volunteer-workers) · [Analysis offload](docs/self-hosting.md#optional-separate-analysis-machine)

## Updating and backups

Back up **PostgreSQL, generated secrets, music and service configuration** together before an upgrade. Never delete secrets independently of the database or use `docker compose down -v` as an update command.

Wait for the GitHub [Release workflow](https://github.com/ChickenBone/mint/actions/workflows/release.yml) to finish for your chosen commit. Then, from the installation directory:

```bash
docker compose pull
docker compose up -d --no-deps --wait worker
docker compose up -d
```

The worker applies database migrations; update it **before** web. In a NAS editor, preserve your storage path and settings, pull the images, recreate worker, wait for health/migrations, then recreate the other services. A restart alone does not use a newly pulled image. No new Plex claim is needed.

`latest` tracks `main`. For reproducible deployments, choose a published version or `sha-…` image tag with `MINT_TAG` in the command-line stack; NAS users should set matching image tags in the template. Changes to a Compose template require updating the project configuration as well as pulling images. [Upgrade details and older migrations](docs/self-hosting.md#updating-an-existing-installation).

## Troubleshooting

| Symptom | First thing to check |
| --- | --- |
| Login does not persist | Use your configured **HTTPS hostname**, not an HTTP IP address. |
| Cloudflare returns 502 | The tunnel route must target **`http://caddy:80`** on the Mint Docker network. |
| Existing music is missing | Check the Plex music section ID, read-only mount and Plex-to-worker path mapping; inspect indexing status in Admin. |
| A volunteer worker says “Never connected” | Its `MINT_URL` must be your public Mint HTTPS origin, not container-local `localhost`. [Worker diagnostics](docs/self-hosting.md#volunteer-workers). |
| A song will not play | Check worker connectivity and file access. Use **MP3 compatibility** if the browser cannot decode its original format. |
| Audio analysis is waiting | Check enable/pause, UTC schedule, concurrency and connected processors in **Admin → Audio analysis**. |
| Charts are unavailable or stale | Read the provider/cache notice; check Redis and web outbound HTTPS. Worldwide community charts can legitimately lag. [Chart setup and limitations](docs/charts.md). |
| An image pull is denied | Confirm the tag exists. Private forks/packages require GHCR sign-in with `read:packages`. |

Use `docker compose ps` and `docker compose logs --tail=100 worker` for details. Review logs before sharing: tokens, paths and library metadata can be sensitive. [More troubleshooting](docs/self-hosting.md#troubleshooting).

## Advanced setup and development

The [Expo consumer app setup](docs/mobile.md) includes native builds and
server configuration. A separately hosted Expo **web** app requires its
exact browser origin in the server's `NATIVE_WEB_ORIGINS` setting and a web
server restart/redeployment; iOS/Android do not require browser CORS.

- [Public agent handbook](agents/README.md) — product decisions, architecture boundaries, design guidance, Playwright fixtures and validation.
- [Portable starter prompt](agents/starter-prompt.md) — reusable instructions for future chats. `npm run agents -- context "<request>" [paths…]` produces a focused guidance/contract/validation packet; add `--json` for automation.
- [Focused mobile features](agents/mobile-features.md) — feature-owned UI, shared contracts and future extension seams. [Ignored agent memory](agents/local-memory.md) is explicitly opt-in and task-scoped, never public context or publication permission.
- [Mint mobile UX skill](.github/skills/mint-mobile-ux/SKILL.md) — compact native interaction guidance with pinned official Expo references loaded on demand; not an app UI rewrite or performance certification.
- [Native app and account transport](docs/mobile.md) · [Native design](docs/mobile-design.md) · [Playback limits](docs/mobile-playback.md) · [Android APKs and EAS updates](docs/android-builds.md)
- [Full self-hosting and integration reference](docs/self-hosting.md)
- [Spotify playlist setup and restrictions](docs/spotify.md)
- [Chart providers, geographic/genre coverage, caching and explicit requests](docs/charts.md)
- [Devices, playback handoff and parties](docs/devices.md)
- [Vercel deployment](docs/self-hosting.md#optional-the-website-on-vercel) — advanced; native playback requires separate private gateway connectivity and platform streaming-limit validation. It is not a drop-in replacement for the all-in-one stack.
- [Local development](docs/self-hosting.md#development) — Node.js 22+, npm workspaces, PostgreSQL and Redis.
- [CI/CD and image publishing](docs/self-hosting.md#cicd) — GitHub Actions checks and multi-architecture images for web, worker, realtime, agent, analysis and the optional chart metadata service.

Mint Smart Fades and audio measurements are independent implementations, not Plexamp's proprietary features. Plex Pass is only relevant to Plex's own entitlement-gated features. Browser autoplay, codecs, offline storage and Android background execution remain subject to browser/device limits; sample-accurate gapless playback and synchronized multi-device audio are not promised.

Only acquire and share content you have permission to use. Availability and terms of third-party APIs, indexers and download services can change.
