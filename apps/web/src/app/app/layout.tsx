import { SignOut } from "@/components/app/sign-out";
import { MobileNav, SidebarNav } from "@/components/app/sidebar-nav";
import { MusicNavigation, MusicStage, PlayerBar, PlayerProvider } from "@/components/app/player";
import { LiveDot } from "@/components/live-dot";
import { Logo } from "@/components/logo";
import { requireUser } from "@/lib/auth";
import { getPendingCount, getPlaylists, getUserSummary } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [playlists, summary, pending] = await Promise.all([
    getPlaylists(user.id),
    getUserSummary(user.id),
    user.role === "admin" ? getPendingCount() : Promise.resolve(0),
  ]);

  return (
    <PlayerProvider memberId={user.id}>
    <div className="grid h-dvh grid-rows-[auto_minmax(0,1fr)_auto] gap-2 bg-bg p-2 pb-[max(.5rem,env(safe-area-inset-bottom))] pt-[max(.5rem,env(safe-area-inset-top))] lg:grid-cols-[18rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)_auto]">
      <aside className="hidden min-h-0 flex-col gap-2 lg:flex">
        <div className="flex items-center justify-between rounded-lg bg-surface px-5 py-4">
          <Logo />
          <LiveDot />
        </div>
        <SidebarNav
          isAdmin={user.role === "admin"}
          pendingRequests={pending}
          activeJobs={summary.active}
          playlists={playlists.map((p) => ({ id: p.id, title: p.title, syncEnabled: p.syncEnabled, itemCount: p.itemCount, artworkUrl: p.artworkUrl }))}
        />
      </aside>

      <MobileNav isAdmin={user.role === "admin"} pendingRequests={pending} />

      <div className="relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg bg-surface">
        <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line px-4 sm:px-6">
          <MusicNavigation />
          <div className="flex shrink-0 items-center gap-3">
          <span className="hidden text-sm text-muted sm:inline">{user.name}</span>
          <SignOut />
          </div>
        </div>
        <MusicStage>{children}</MusicStage>
      </div>
      <PlayerBar />
    </div>
    </PlayerProvider>
  );
}
