"use client";

import clsx from "clsx";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { SyncState } from "@mint/core/events";
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  HardDrive,
  Link2,
  MonitorSpeaker,
  PauseCircle,
  ShieldCheck,
  SlidersHorizontal,
  User,
} from "lucide-react";
import { unlinkYoutube, updateSyncSettings } from "@/app/actions/member";
import { setSpotifyAutoSync } from "@/app/actions/spotify";
import { InstallApp } from "@/components/install-app";
import { Badge } from "@/components/ui/primitives";
import { resolveSettingsSection, type SettingsSectionId } from "@/lib/app-routes";
import type { DeviceStore } from "@/lib/devices-store";
import { timeAgo } from "@/lib/format";
import { ActionButton } from "./admin-controls";
import { DevicesPanel } from "./devices-panel";
import { Downloads } from "./downloads";
import { LinkYoutubeCallout } from "./link-youtube";
import { PageHeader } from "./page-header";
import { AudioPanel } from "./player-panels";
import { usePlayer } from "./player";
import { PlaylistToggle } from "./playlist-toggle";
import { ReportIssueButton } from "./report-issue";
import { SignOut } from "./sign-out";
import { SpotifyAccountControls, SpotifyImportForm, SpotifyPlaylistToggle } from "./spotify-controls";
import { SyncPanel } from "./sync-panel";

type Devices = Awaited<ReturnType<DeviceStore["list"]>>;
type Parties = Awaited<ReturnType<DeviceStore["listParties"]>>;

const OAUTH_ERRORS: Record<string, string> = {
  denied: "Google sign-in was cancelled. Nothing was linked.",
  state: "That sign-in link expired. Start again from this page.",
  scope: "Mint needs read access to your YouTube account. Try again and leave the YouTube box ticked.",
  refresh: "Google didn't return a long-lived token. Remove Mint from your Google account permissions, then link again.",
  failed: "Linking failed on our side. Try again in a minute.",
};

const SPOTIFY_ERRORS: Record<string, string> = {
  setup: "Spotify is not configured on this server. Ask the operator to complete the setup below.",
  state: "That Spotify sign-in link expired or belongs to another session. Start again here.",
  denied: "Spotify sign-in was cancelled. Nothing was changed.",
  rate: "Too many connection attempts. Wait a few minutes, then try again.",
  access: "Spotify denied access. Check the app owner’s Premium subscription and your developer-app allowlist entry.",
  failed: "Spotify could not be connected. Check read permissions, app configuration and your allowlist entry, then reconnect.",
  queue: "Spotify is connected, but the sync queue is unavailable. Try Sync now when the worker is running.",
};

export interface SettingsViewProps {
  user: { id: string; name: string; email: string; role: string };
  pendingManagementCount: number;
  youtubeAccount: {
    channelTitle: string | null;
    email: string | null;
    lastSyncedAt: string | null;
    musicOnly: boolean;
    autoSync: boolean;
    syncState: SyncState;
  } | null;
  youtubePlaylists: Array<{
    id: string;
    title: string;
    itemCount: number;
    syncEnabled: boolean;
  }>;
  spotifyConfigured: boolean;
  spotifyExtended: boolean;
  spotifyAccount: {
    displayName: string;
    status: string;
    error: string | null;
    autoSync: boolean;
    lastSyncedAt: string | null;
    nextSyncAt: string;
  } | null;
  spotifyPlaylists: Array<{
    id: string;
    title: string;
    sourceTotal: number;
    matchedTotal: number;
    syncEnabled: boolean;
    status: string;
    error: string | null;
    lastSyncedAt: string | null;
  }>;
  initialDevices: Devices;
  initialParties: Parties;
}

const SECTIONS: Array<{
  id: SettingsSectionId;
  label: string;
  description: string;
  icon: typeof User;
}> = [
  {
    id: "account",
    label: "Account",
    description: "Your profile and the app on this device",
    icon: User,
  },
  {
    id: "services",
    label: "Music imports",
    description: "Optional playlists from YouTube Music and Spotify",
    icon: Link2,
  },
  {
    id: "playback",
    label: "Playback & sound",
    description: "Equalizer, volume balance and song transitions",
    icon: SlidersHorizontal,
  },
  {
    id: "devices",
    label: "Devices & parties",
    description: "Move your music or listen together on one device",
    icon: MonitorSpeaker,
  },
  {
    id: "storage",
    label: "Downloads & storage",
    description: "Music saved for listening without a connection",
    icon: HardDrive,
  },
];

export function SettingsView({
  user,
  pendingManagementCount,
  youtubeAccount,
  youtubePlaylists,
  spotifyConfigured,
  spotifyExtended,
  spotifyAccount,
  spotifyPlaylists,
  initialDevices,
  initialParties,
}: SettingsViewProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const player = usePlayer();

  const rawSection = searchParams.get("section");
  const hasOauthNotice =
    searchParams.has("linked") ||
    searchParams.has("error") ||
    searchParams.has("spotify_linked") ||
    searchParams.has("spotify_error");
  const effectiveSection: SettingsSectionId = rawSection
    ? resolveSettingsSection(rawSection)
    : hasOauthNotice
      ? "services"
      : "account";
  const mobileDetailOpen = Boolean(rawSection || hasOauthNotice);

  const selectSection = (id: SettingsSectionId) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("section", id);
    router.replace(`/app/settings?${next.toString()}`, { scroll: false });
  };

  const closeMobileDetail = () => {
    router.replace("/app/settings", { scroll: false });
  };

  const ytLinked = searchParams.get("linked");
  const ytError = searchParams.get("error");
  const spLinked = searchParams.get("spotify_linked");
  const spError = searchParams.get("spotify_error");

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Settings"
        sub="Make Mint feel like yours. Your account, your sound, your devices."
      />

      <div className="grid gap-8 md:grid-cols-[17rem_minmax(0,1fr)] lg:grid-cols-[19rem_minmax(0,1fr)]">
        <nav
          aria-label="Settings sections"
          className={clsx("space-y-1", mobileDetailOpen ? "hidden md:block" : "block")}
        >
          {SECTIONS.map(({ id, label, description, icon: Icon }) => {
            const isSelected = effectiveSection === id;
            return (
              <button
                key={id}
                type="button"
                aria-current={isSelected ? "true" : undefined}
                onClick={() => selectSection(id)}
                className={clsx(
                  "flex min-h-14 w-full items-start gap-3 rounded-surface p-3.5 text-left transition-colors",
                  isSelected ? "bg-elevated text-fg ring-1 ring-line" : "text-muted hover:bg-elevated/60 hover:text-fg",
                )}
              >
                <Icon className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-fg">{label}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted">{description}</span>
                </span>
              </button>
            );
          })}

          <div className="mt-4 border-t border-line pt-4">
            <Link href="/app/collection?tab=history" className="flex min-h-11 items-center rounded-surface px-4 text-sm text-muted hover:bg-elevated hover:text-fg">
              Listening history
            </Link>
            <Link href="/app/collection?tab=requests" className="flex min-h-11 items-center rounded-surface px-4 text-sm text-muted hover:bg-elevated hover:text-fg">
              Your music requests
            </Link>
            <ReportIssueButton
              icon={false}
              className="w-full rounded-surface px-4 text-muted hover:bg-elevated hover:text-fg"
            />
          </div>

          {user.role === "admin" && (
            <div className="mt-4 border-t border-line pt-4">
              <Link
                href="/app/manage"
                className="flex min-h-14 w-full items-start justify-between gap-3 rounded-surface p-3.5 text-left text-muted transition-colors hover:bg-elevated/60 hover:text-fg"
              >
                <span className="flex items-start gap-3">
                  <ShieldCheck className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden />
                  <span>
                    <span className="flex items-center gap-2 text-sm font-semibold text-fg">
                      Admin portal
                      {pendingManagementCount > 0 && <Badge tone="warning">{pendingManagementCount}</Badge>}
                    </span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                      Membership, services and library operations
                    </span>
                  </span>
                </span>
                <ArrowUpRight className="mt-1 size-4 shrink-0 text-muted" aria-hidden />
              </Link>
            </div>
          )}
        </nav>

        <div className={clsx("min-w-0", !mobileDetailOpen ? "hidden md:block" : "block")}>
          <button
            type="button"
            onClick={closeMobileDetail}
            className="mb-5 inline-flex min-h-11 items-center gap-2 rounded-full bg-elevated px-4 text-sm font-semibold text-fg hover:bg-hover md:hidden"
          >
            <ArrowLeft className="size-4" aria-hidden />
            All settings
          </button>

          {effectiveSection === "account" && (
            <section aria-labelledby="settings-account-heading" className="space-y-8">
              <div>
                <h2 id="settings-account-heading" className="text-2xl font-bold tracking-tight">
                  Account
                </h2>
                <p className="mt-1 max-w-prose text-sm text-muted">
                  Your private Mint membership and session on this device.
                </p>
              </div>

              <div className="rounded-surface border border-line bg-elevated/50 p-5">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-lg font-bold text-fg">{user.name}</p>
                      <Badge tone="neutral">{user.role === "admin" ? "Admin" : "Member"}</Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted">Signed in as {user.email}</p>
                  </div>
                  <SignOut />
                </div>
              </div>

              <div className="border-t border-line pt-6">
                <h3 className="text-lg font-bold">Install app</h3>
                <p className="mt-1 mb-4 max-w-prose text-sm text-muted">
                  Add Mint to your home screen or desktop dock for quick access.
                </p>
                <InstallApp />
              </div>

              <details className="border-t border-line pt-6">
                <summary className="min-h-11 cursor-pointer text-sm font-semibold text-muted">Using an external library client</summary>
                <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted">
                  Browsing, playback, queues, lyrics and sound controls belong directly to Mint. If you also use an optional external Plex client such as Plexamp, it needs its own separate Plex library invitation from the server admin.
                </p>
              </details>
            </section>
          )}

          {effectiveSection === "services" && (
            <section aria-labelledby="settings-services-heading" className="space-y-10">
              <div>
                <h2 id="settings-services-heading" className="text-2xl font-bold tracking-tight">
                  Music imports
                </h2>
                <p className="mt-1 max-w-prose text-sm text-muted">
                  Bring familiar playlists into Mint, if you want to. You can listen and create your own playlists without connecting anything.
                </p>
              </div>

              {ytLinked && (
                <p className="rounded-lg bg-mint/10 px-4 py-3 text-sm text-mint" role="status">
                  YouTube Music is linked. Mint is bringing in your music.
                </p>
              )}
              {ytError && (
                <p className="rounded-lg bg-danger/10 px-4 py-3 text-sm text-danger" role="alert">
                  {OAUTH_ERRORS[ytError] ?? OAUTH_ERRORS.failed}
                </p>
              )}
              {spLinked && (
                <p className="rounded-lg bg-mint/10 px-4 py-3 text-sm text-mint" role="status">
                  Spotify connected. Playlist discovery has been queued.
                </p>
              )}
              {spError && (
                <p className="rounded-lg bg-danger/10 px-4 py-3 text-sm text-danger" role="alert">
                  {SPOTIFY_ERRORS[spError] ?? SPOTIFY_ERRORS.failed}
                </p>
              )}

              {/* YouTube Music */}
              <div className="space-y-6 rounded-surface border border-line bg-elevated/40 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-xl font-bold">YouTube Music</h3>
                      <Badge tone={youtubeAccount ? "positive" : "neutral"}>
                        {youtubeAccount ? "Connected" : "Not connected"}
                      </Badge>
                    </div>
                    <p className="mt-1 max-w-prose text-sm text-muted">
                      Import your liked songs and selected playlists. Your YouTube account stays read-only.
                    </p>
                  </div>
                </div>

                {youtubeAccount ? (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line pt-4">
                      <div>
                        <p className="font-semibold">{youtubeAccount.channelTitle ?? youtubeAccount.email ?? "Google account"}</p>
                        <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted">
                          <CheckCircle2 className="size-3.5 text-mint" aria-hidden />
                          <span>
                            Last updated {timeAgo(youtubeAccount.lastSyncedAt ? new Date(youtubeAccount.lastSyncedAt) : null)}
                          </span>
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <a
                          href="/api/oauth/google/start"
                          className="inline-flex min-h-11 items-center rounded-full px-4 text-sm font-semibold ring-1 ring-line hover:bg-elevated"
                        >
                          Relink
                        </a>
                        <ActionButton
                          action={unlinkYoutube}
                          tone="danger"
                          confirmTitle="Unlink YouTube Music?"
                          confirm="Unlink YouTube Music? Your downloaded songs stay in Mint, but new likes and playlist changes will stop syncing."
                        >
                          Unlink
                        </ActionButton>
                      </div>
                    </div>

                    <details className="border-t border-line pt-5">
                      <summary className="min-h-11 cursor-pointer font-semibold">Import preferences &amp; status</summary>
                      <div className="mt-4"><SyncPanel initial={youtubeAccount.syncState} /></div>
                      <p className="mt-4 max-w-prose text-sm text-muted">Changes apply from the next import.</p>
                      <form action={updateSyncSettings} className="mt-4 flex flex-col gap-4">
                        <label className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            name="musicOnly"
                            defaultChecked={youtubeAccount.musicOnly}
                            className="mt-1 size-4 accent-mint"
                          />
                          <span>
                            <span className="block text-sm font-semibold">Only music from likes</span>
                            <span className="block max-w-prose text-xs text-muted">
                              Skip liked videos that YouTube doesn&rsquo;t file under Music, like podcasts or vlogs.
                            </span>
                          </span>
                        </label>
                        <label className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            name="autoSync"
                            defaultChecked={youtubeAccount.autoSync}
                            className="mt-1 size-4 accent-mint"
                          />
                          <span>
                            <span className="block text-sm font-semibold">Keep imports up to date</span>
                            <span className="block max-w-prose text-xs text-muted">
                              Check for new likes every 30 minutes. Turn off to sync only when you press Sync now.
                            </span>
                          </span>
                        </label>
                        <button
                          type="submit"
                          className="mt-1 min-h-11 self-start rounded-full bg-fg px-5 text-sm font-bold text-bg hover:bg-fg/90"
                        >
                          Save import preferences
                        </button>
                      </form>
                    </details>

                    <div className="border-t border-line pt-5">
                      <h4 className="font-semibold">YouTube Music playlists</h4>
                      <p className="mt-1 max-w-prose text-xs text-muted">
                        Liked songs are included. Select any playlist to bring its songs into Mint.
                      </p>
                      {youtubePlaylists.length === 0 ? (
                        <p className="mt-3 text-sm text-muted">
                          No playlists found on your account yet. They appear here after the next import.
                        </p>
                      ) : (
                        <ul className="mt-3 divide-y divide-line">
                          {youtubePlaylists.map((p) => (
                            <li key={p.id} className="flex items-center justify-between gap-4 py-3">
                              <div className="min-w-0">
                                <Link href={`/app/collection/${p.id}`} className="truncate font-medium hover:underline">
                                  {p.title}
                                </Link>
                                <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted tabular">
                                  {p.syncEnabled ? (
                                    <>
                                      <CheckCircle2 className="size-3.5 text-mint" aria-hidden />
                                      <span>Selected · {p.itemCount} songs</span>
                                    </>
                                  ) : (
                                    <>
                                      <PauseCircle className="size-3.5 text-muted" aria-hidden />
                                      <span>Not selected · {p.itemCount} songs</span>
                                    </>
                                  )}
                                </p>
                              </div>
                              <PlaylistToggle id={p.id} enabled={p.syncEnabled} label={p.title} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </>
                ) : (
                  <LinkYoutubeCallout />
                )}
              </div>

              {/* Spotify */}
              <div className="space-y-6 rounded-surface border border-line bg-elevated/40 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-xl font-bold">Spotify</h3>
                      <Badge
                        tone={
                          !spotifyAccount
                            ? "neutral"
                            : spotifyAccount.status === "rate_limited"
                              ? "warning"
                              : spotifyAccount.error
                                ? "danger"
                                : "positive"
                        }
                      >
                        {!spotifyAccount ? "Not connected" : spotifyAccount.status.replaceAll("_", " ")}
                      </Badge>
                    </div>
                    <p className="mt-1 max-w-prose text-sm text-muted">
                      Read-only playlist metadata matched to songs already in your library. Missing songs stay visible and never trigger downloads.
                    </p>
                  </div>
                </div>

                {spotifyAccount ? (
                  <>
                    <div>
                      <p className="font-semibold">{spotifyAccount.displayName}</p>
                      <p className="mt-1 text-sm text-muted">
                        Status: {spotifyAccount.status.replaceAll("_", " ")} · Last checked{" "}
                        {timeAgo(spotifyAccount.lastSyncedAt ? new Date(spotifyAccount.lastSyncedAt) : null)}
                      </p>
                      {spotifyAccount.error && (
                        <p className="mt-2 text-sm text-danger" role="alert">
                          {spotifyAccount.error}
                        </p>
                      )}
                      {spotifyAccount.status === "rate_limited" && (
                        <p className="mt-2 text-sm text-warn">
                          Retry after {new Date(spotifyAccount.nextSyncAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC.
                        </p>
                      )}
                      <details className="mt-4 border-t border-line pt-4">
                      <summary className="min-h-11 cursor-pointer font-semibold">Import preferences &amp; status</summary>
                      <div className="mt-4">
                        <SpotifyAccountControls />
                      </div>
                      <form action={setSpotifyAutoSync} className="mt-5 flex flex-wrap items-center gap-4 border-t border-line pt-5">
                        <label className="flex items-start gap-3 text-sm">
                          <input
                            name="autoSync"
                            type="checkbox"
                            defaultChecked={spotifyAccount.autoSync}
                            className="mt-1 size-4 accent-mint"
                          />
                          <span>
                            <span className="block font-semibold">Check selected playlists every 30 minutes</span>
                            <span className="mt-0.5 block max-w-prose text-xs text-muted">
                              Respects provider cooldowns. Manual sync remains available anytime.
                            </span>
                          </span>
                        </label>
                        <button
                          type="submit"
                          className="min-h-11 rounded-full px-5 text-sm font-semibold ring-1 ring-line hover:bg-hover"
                        >
                          Save schedule
                        </button>
                      </form>
                      </details>
                    </div>

                    <div className="border-t border-line pt-5">
                      <SpotifyImportForm />
                    </div>

                    <div className="border-t border-line pt-5">
                      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                        <h4 className="font-semibold">Spotify playlists</h4>
                        <span className="text-xs text-muted">Read-only source playlists</span>
                      </div>
                      {!spotifyPlaylists.length ? (
                        <p className="max-w-prose text-sm text-muted">
                          Your accessible playlists appear after the first sync. Add a playlist link above, or press Sync now.
                        </p>
                      ) : (
                        <ul className="divide-y divide-line">
                          {spotifyPlaylists.map((p) => (
                            <li key={p.id} className="flex flex-wrap items-center justify-between gap-4 py-3.5">
                              <div className="min-w-0 flex-1 basis-44">
                                <Link href={`/app/collection/${p.id}`} className="block truncate font-semibold hover:text-mint">
                                  {p.title}
                                </Link>
                                <p className="mt-0.5 text-xs text-muted tabular">
                                  {p.lastSyncedAt ? `${p.matchedTotal} of ${p.sourceTotal} matched at last sync` : "Not synced yet"} ·{" "}
                                  {p.status.replaceAll("_", " ")}
                                </p>
                                {p.error && <p className="mt-1 text-xs text-danger">{p.error}</p>}
                              </div>
                              <SpotifyPlaylistToggle id={p.id} enabled={p.syncEnabled} title={p.title} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </>
                ) : spotifyConfigured ? (
                  <div>
                    <p className="mb-4 max-w-prose text-sm text-muted">
                      Allow Mint to read your Spotify playlist metadata. Spotify stays read-only; playback always uses songs already available in your local library.
                    </p>
                    <a
                      href="/api/oauth/spotify/start"
                      className="inline-flex min-h-11 items-center rounded-full bg-mint px-5 text-sm font-bold text-mint-ink hover:bg-mint-strong"
                    >
                      Connect Spotify
                    </a>
                  </div>
                ) : (
                  <div className="max-w-prose text-sm text-muted">
                    <p className="font-semibold text-fg">Spotify imports are not available on this server</p>
                    <p className="mt-1">
                      You can still enjoy the library and make Mint playlists. Ask your administrator if you would like Spotify imports enabled.
                    </p>
                    {user.role === "admin" && <details className="mt-4">
                      <summary className="min-h-11 cursor-pointer font-semibold">Server configuration</summary>
                      <p>Configure SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET on the web app and worker, plus the shared encryption key.</p>
                    </details>}
                  </div>
                )}

                <p className="border-t border-line pt-4 max-w-prose text-xs text-muted">
                  {spotifyExtended
                    ? "Configured for Spotify extended-quota access. Import still depends on provider authorization."
                    : "Spotify development mode: the app owner needs Premium, and new apps support up to five allowlisted users. Only playlists you own or collaborate on expose their contents."}
                </p>
              </div>
            </section>
          )}

          {effectiveSection === "playback" && (
            <section aria-labelledby="settings-playback-heading" className="space-y-6">
              <div>
                <h2 id="settings-playback-heading" className="text-2xl font-bold tracking-tight">
                  Playback and sound
                </h2>
                <p className="mt-1 max-w-prose text-sm text-muted">
                  Configure audio compatibility, 10-band equalization, transitions, Smart Fades and loudness normalization for this device.
                </p>
              </div>
              {player?.ready ? (
                <div className="max-w-2xl rounded-surface border border-line bg-elevated/40 p-5">
                  <AudioPanel state={player.state} command={player.command} showPlayback />
                </div>
              ) : (
                <p className="text-sm text-muted" role="status">
                  Connecting to your audio player…
                </p>
              )}
            </section>
          )}

          {effectiveSection === "devices" && (
            <section aria-labelledby="settings-devices-heading" className="space-y-6">
              <div>
                <h2 id="settings-devices-heading" className="text-2xl font-bold tracking-tight">
                  Devices
                </h2>
                <p className="mt-1 max-w-prose text-sm text-muted">
                  Control your signed-in devices, hand off active playback, or host a single-output listening party. Keep Mint open on a device to control it remotely.
                </p>
              </div>
              <DevicesPanel initialDevices={initialDevices} initialParties={initialParties} />
            </section>
          )}

          {effectiveSection === "storage" && (
            <section aria-labelledby="settings-storage-heading" className="space-y-6">
              <div>
                <h2 id="settings-storage-heading" className="text-2xl font-bold tracking-tight">
                  Offline storage
                </h2>
                <p className="mt-1 max-w-prose text-sm text-muted">
                  Manage downloaded songs and browser storage limits on this device.
                </p>
              </div>
              <Downloads memberId={user.id} embedded />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
