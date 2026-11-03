import type { Metadata } from "next";
import Link from "next/link";
import { InstallApp } from "@/components/install-app";
import { unlinkYoutube, updateSyncSettings } from "@/app/actions/member";
import { ActionButton } from "@/components/app/admin-controls";
import { LinkYoutubeCallout } from "@/components/app/link-youtube";
import { PageHeader } from "@/components/app/page-header";
import { PlaylistToggle } from "@/components/app/playlist-toggle";
import { requireUser } from "@/lib/auth";
import { getPlaylists, getYoutubeAccount } from "@/lib/data";
import { timeAgo } from "@/lib/format";

export const metadata: Metadata = { title: "Settings" };

const OAUTH_ERRORS: Record<string, string> = {
  denied: "Google sign-in was cancelled. Nothing was linked.",
  state: "That sign-in link expired. Start again from this page.",
  scope: "Mint needs read access to your YouTube account. Try again and leave the YouTube box ticked.",
  refresh: "Google didn't return a long-lived token. Remove Mint from your Google account permissions, then link again.",
  failed: "Linking failed on our side. Try again in a minute.",
};

function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line py-8 first:border-t-0 first:pt-0">
      <h2 className="text-xl font-bold">{title}</h2>
      {sub && <p className="mt-1 max-w-2xl text-sm text-muted">{sub}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

export default async function Settings({ searchParams }: { searchParams: Promise<{ linked?: string; error?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const [acct, playlists] = await Promise.all([getYoutubeAccount(user.id), getPlaylists(user.id)]);

  return (
    <>
      <PageHeader title="Settings" />
      {sp.linked && <p className="mb-6 rounded-lg bg-mint/10 px-4 py-3 text-sm text-mint" role="status">YouTube Music is linked. Your first sync has started.</p>}
      {sp.error && (
        <p className="mb-6 rounded-lg bg-danger/10 px-4 py-3 text-sm text-danger" role="alert">
          {OAUTH_ERRORS[sp.error] ?? OAUTH_ERRORS.failed}
        </p>
      )}

      <div className="max-w-3xl">
        <Section title="YouTube Music">
          {acct ? (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="font-semibold">{acct.channelTitle ?? acct.email ?? "Google account"}</p>
                <p className="text-sm text-muted">
                  {acct.email} · last synced {timeAgo(acct.lastSyncedAt)}
                </p>
              </div>
              <div className="flex gap-2">
                <a href="/api/oauth/google/start" className="inline-flex h-8 items-center rounded-full px-4 text-sm font-semibold ring-1 ring-line hover:bg-elevated">
                  Relink
                </a>
                <ActionButton
                  action={unlinkYoutube}
                  tone="danger"
                  confirm="Unlink YouTube Music? Your downloaded songs stay on the server, but Mint stops syncing new likes."
                >
                  Unlink
                </ActionButton>
              </div>
            </div>
          ) : (
            <LinkYoutubeCallout />
          )}
        </Section>

        {acct && (
          <Section title="What to sync" sub="Changes apply from the next sync.">
            <form action={updateSyncSettings} className="flex flex-col gap-4">
              <label className="flex items-start gap-3">
                <input type="checkbox" name="musicOnly" defaultChecked={acct.musicOnly} className="mt-1 size-4 accent-mint" />
                <span>
                  <span className="block font-semibold">Only music from likes</span>
                  <span className="block text-sm text-muted">Skip liked videos that YouTube doesn&rsquo;t file under Music, like podcasts or vlogs.</span>
                </span>
              </label>
              <label className="flex items-start gap-3">
                <input type="checkbox" name="autoSync" defaultChecked={acct.autoSync} className="mt-1 size-4 accent-mint" />
                <span>
                  <span className="block font-semibold">Sync automatically</span>
                  <span className="block text-sm text-muted">Check for new likes every 30 minutes. Turn off to sync only when you press Sync now.</span>
                </span>
              </label>
              <button type="submit" className="mt-2 h-10 self-start rounded-full bg-fg px-5 text-sm font-bold text-bg transition hover:scale-[1.03]">
                Save sync settings
              </button>
            </form>
          </Section>
        )}

        {acct && (
          <Section title="Playlists" sub="Liked songs always sync. Turn on any playlist to download it and mirror it in Plex.">
            {playlists.length === 0 ? (
              <p className="text-muted">No playlists found on your account yet. They appear here after the next sync.</p>
            ) : (
              <ul className="divide-y divide-line">
                {playlists.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{p.title}</p>
                      <p className="text-sm text-muted tabular">{p.itemCount} songs</p>
                    </div>
                    <PlaylistToggle id={p.id} enabled={p.syncEnabled} label={p.title} />
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}

        <Section title="Listen">
          <div className="mb-6"><InstallApp /></div>
          <p className="mb-4 max-w-2xl text-muted">Listen to downloaded music directly in Mint. Browsing, playback, queues, lyrics and sound controls belong to Mint; Plex remains the private library server. The separate installed Plexamp app is optional and needs its own Plex library invitation.</p>
          <div className="mb-6 flex flex-wrap gap-3">
            <Link href="/app/music" className="rounded-full bg-mint px-5 py-2.5 font-semibold text-mint-ink hover:brightness-110">Open music</Link>
            <a href="plexamp://" className="rounded-full bg-elevated px-5 py-2.5 font-semibold hover:bg-hover">Open Plexamp</a>
          </div>
          <ol className="flex max-w-2xl list-decimal flex-col gap-2 pl-5 text-muted marker:text-faint">
            <li>Install Plexamp on your phone or desktop and sign in with your Plex account.</li>
            <li>Accept the library invite from the server admin. If you don&rsquo;t have one, ask them to share Mint&rsquo;s music library with your Plex email.</li>
            <li>
              Open Playlists. Yours are named <span className="text-fg">Mint · {user.name} · …</span>
            </li>
          </ol>
        </Section>

        <Section title="Account">
          <p className="text-muted">
            Signed in as <span className="text-fg">{user.email}</span>.
          </p>
        </Section>
      </div>
    </>
  );
}
