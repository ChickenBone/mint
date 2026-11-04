import type { Metadata } from "next";
import Link from "next/link";
import { asc, eq, sql } from "drizzle-orm";
import { getDb } from "@mint/core/db";
import { spotifyPlaylists } from "@mint/core/spotify-db";
import { spotifyConfigured, spotifyExtended } from "@mint/core/spotify";
import { spotifyAccountView } from "@mint/core/spotify-store";
import { setSpotifyAutoSync } from "@/app/actions/spotify";
import { requireUser } from "@/lib/auth";
import { timeAgo } from "@/lib/format";
import { PageHeader } from "@/components/app/page-header";
import { SpotifyAccountControls, SpotifyImportForm, SpotifyPlaylistToggle } from "@/components/app/spotify-controls";

export const metadata: Metadata = { title: "Spotify playlists" };
export const dynamic = "force-dynamic";
const errors: Record<string, string> = {
  setup: "Spotify is not configured on this server. Ask the operator to complete the setup below.",
  state: "That Spotify sign-in link expired or belongs to another session. Start again here.",
  denied: "Spotify sign-in was cancelled. Nothing was changed.",
  rate: "Too many connection attempts. Wait a few minutes, then try again.",
  access: "Spotify denied access. Check the app owner’s Premium subscription and your developer-app allowlist entry.",
  failed: "Spotify could not be connected. Check read permissions, app configuration and your allowlist entry, then reconnect.",
  queue: "Spotify is connected, but the sync queue is unavailable. Try Sync now when the worker is running.",
};
export default async function SpotifyPage({ searchParams }: { searchParams: Promise<{ error?: string; linked?: string; page?: string }> }) {
  const user = await requireUser(), db = getDb(), params = await searchParams;
  const [account, [count]] = await Promise.all([spotifyAccountView(db, user.id), db.select({ total: sql<number>`count(*)::int` })
    .from(spotifyPlaylists).where(eq(spotifyPlaylists.userId, user.id))]);
  const total = Number(count?.total ?? 0), requested = Number(params.page ?? 0);
  const page = Math.min(Number.isSafeInteger(requested) && requested >= 0 ? requested : 0, Math.max(0, Math.ceil(total / 100) - 1));
  const playlists = await db.select().from(spotifyPlaylists).where(eq(spotifyPlaylists.userId, user.id))
    .orderBy(asc(spotifyPlaylists.title), asc(spotifyPlaylists.id)).limit(100).offset(page * 100);
  const configured = spotifyConfigured();
  return <>
    <PageHeader title="Spotify playlists" sub="Your playlist order. Your local Plex music. No Spotify audio streams or downloads." />
    {params.error && <p className="mb-6 max-w-3xl text-sm text-danger" role="alert">{errors[params.error] ?? errors.failed}</p>}
    {params.linked && <p className="mb-6 text-sm text-mint" role="status">Spotify connected. Playlist discovery has been queued.</p>}
    <section className="max-w-3xl pb-8">
      <h2 className="text-xl font-bold">{account ? account.displayName : "Connect your account"}</h2>
      {account ? <>
        <p className="mt-2 mb-5 text-sm text-muted">Status: {account.status.replaceAll("_", " ")} · Last checked {timeAgo(account.lastSyncedAt)}</p>
        {account.error && <p className="mb-4 text-sm text-danger" role="alert">{account.error}</p>}
        {account.status === "rate_limited" && <p className="mb-4 text-sm text-warn">Retry after {account.nextSyncAt.toLocaleString("en-US", { timeZone: "UTC" })} UTC.</p>}
        <SpotifyAccountControls />
        <form action={setSpotifyAutoSync} className="mt-6 flex flex-wrap items-center gap-4">
          <label className="flex items-start gap-3 text-sm">
            <input name="autoSync" type="checkbox" defaultChecked={account.autoSync} className="mt-1 size-4 accent-mint" />
            <span>Check selected playlists every 30 minutes<span className="mt-1 block text-muted">The worker respects provider cooldowns. Manual sync remains available.</span></span>
          </label>
          <button className="min-h-11 rounded-full px-5 text-sm font-semibold ring-1 ring-line hover:bg-hover">Save schedule</button>
        </form>
      </> : configured ? <>
        <p className="mt-2 mb-5 max-w-2xl text-muted">Allow Mint to read playlist metadata. Spotify stays read-only; playback always uses songs already available in the local Plex-indexed library.</p>
        <a href="/api/oauth/spotify/start" className="inline-flex min-h-11 items-center rounded-full bg-mint px-5 text-sm font-bold text-mint-ink hover:bg-mint-strong">Connect Spotify</a>
      </> : <div className="mt-3 max-w-2xl text-muted">
        <p className="font-semibold text-fg">Server setup required</p>
        <p className="mt-2">The operator must configure SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET on the web app and worker, plus the shared encryption key. Register the exact public callback URL ending in /api/oauth/spotify/callback in Spotify’s developer dashboard.</p>
        <p className="mt-2">No credentials are sent to your browser. Existing local music and YouTube sync are unaffected.</p>
      </div>}
      <p className="mt-6 max-w-2xl text-sm text-muted">{spotifyExtended() ? "This server is configured for Spotify extended-quota access. Import still depends on the provider’s authorization." :
        "Spotify development mode: the app owner needs Premium, and new apps support up to five allowlisted users. Only playlists you own or collaborate on expose their contents; followed and editorial playlists may not be importable."}</p>
    </section>
    {account && <>
      <section className="border-t border-line py-8"><SpotifyImportForm /></section>
      <section className="border-t border-line py-8">
        <div className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-2xl font-bold">Choose what to sync</h2><p className="text-sm text-muted">Spotify source playlists are read-only</p>
        </div>
        {!playlists.length ? <p className="max-w-2xl text-muted">Your accessible playlists appear after the first sync. Add a link above, or use Sync now and refresh in a moment.</p> :
          <ul className="divide-y divide-line">{playlists.map((p) => <li key={p.id} className="flex flex-wrap items-center justify-between gap-4 py-5">
            <div className="min-w-0 flex-1 basis-44">
              <Link href={`/app/spotify/${p.id}`} className="block truncate text-lg font-semibold hover:text-mint">{p.title}</Link>
              <p className="mt-1 text-sm text-muted">{p.lastSyncedAt ? `${p.matchedTotal} of ${p.sourceTotal} matched at last sync` : "Not synced yet"} · {p.status.replaceAll("_", " ")}</p>
              {p.error && <p className="mt-2 text-sm text-danger">{p.error}</p>}
            </div>
            <SpotifyPlaylistToggle id={p.id} enabled={p.syncEnabled} title={p.title} />
          </li>)}</ul>}
        {total > 100 && <nav aria-label="Spotify playlists" className="mt-5 flex flex-wrap items-center gap-5 text-sm">
          {page > 0 && <Link className="inline-flex min-h-11 items-center hover:text-mint" href={`/app/spotify?page=${page - 1}`}>Previous 100</Link>}
          <span className="text-muted">{page * 100 + 1}–{Math.min((page + 1) * 100, total)} of {total}</span>
          {(page + 1) * 100 < total && <Link className="inline-flex min-h-11 items-center hover:text-mint" href={`/app/spotify?page=${page + 1}`}>Next 100</Link>}
        </nav>}
      </section>
    </>}
    <Link href="/app/settings" className="inline-flex min-h-11 items-center text-sm text-muted hover:text-fg">Back to settings</Link>
  </>;
}
