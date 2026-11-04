import { SignOut } from "@/components/app/sign-out";
import { MobileNav, SidebarNav } from "@/components/app/sidebar-nav";
import { MusicNavigation, MusicStage, PlayerBar, PlayerProvider } from "@/components/app/player";
import { LiveDot } from "@/components/live-dot";
import { Logo } from "@/components/logo";
import { ToastProvider } from "@/components/ui/toast";
import { requireUser } from "@/lib/auth";
import { getPendingCount, getPlaylists, getUserSummary } from "@/lib/data";
import Link from "next/link";

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
    <ToastProvider>
    <div className="app-shell grid h-dvh grid-rows-[minmax(0,1fr)_auto_auto] bg-bg lg:grid-cols-[16rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)_auto]">
      <a href="#listening-content" className="skip-link">Skip to content</a>
      <aside className="hidden min-h-0 flex-col border-r border-line/60 lg:flex">
        <div className="flex h-24 shrink-0 items-center justify-between px-8">
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

      <div className="relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-surface">
        <div className="listening-topbar flex h-20 shrink-0 items-center justify-between gap-3 px-5 sm:px-10 xl:px-12">
          <span className="lg:hidden"><Logo /></span>
          <MusicNavigation />
          <div className="flex shrink-0 items-center gap-3">
          <Link href="/app/settings" aria-label="Your account and settings" className="flex min-h-11 items-center gap-3 rounded-full px-2 text-sm text-muted hover:text-fg"><span className="hidden sm:inline">{user.name}</span><span className="grid size-9 place-items-center rounded-full bg-elevated font-bold text-fg">{user.name.slice(0, 1)}</span></Link>
          <span className="hidden xl:block"><SignOut /></span>
          </div>
        </div>
        <MusicStage>{children}</MusicStage>
      </div>
      <PlayerBar />
      <MobileNav />
    </div>
    </ToastProvider>
    </PlayerProvider>
  );
}
