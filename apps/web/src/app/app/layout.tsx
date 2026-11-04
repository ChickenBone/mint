import { SignOut } from "@/components/app/sign-out";
import { MobileNav, SettingsLink, SidebarNav } from "@/components/app/sidebar-nav";
import { MusicNavigation, MusicStage, PlayerBar, PlayerProvider } from "@/components/app/player";
import { LiveDot } from "@/components/live-dot";
import { Logo } from "@/components/logo";
import { ToastProvider } from "@/components/ui/toast";
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
    <ToastProvider>
    <PlayerProvider memberId={user.id}>
    <div className="app-shell grid h-dvh grid-rows-[minmax(0,1fr)_auto_auto] bg-bg md:grid-cols-[5rem_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)_auto] lg:grid-cols-[16rem_minmax(0,1fr)]">
      <a href="#listening-content" className="skip-link">Skip to content</a>
      <aside className="hidden min-h-0 flex-col border-r border-line/60 md:flex">
        <div className="flex h-20 shrink-0 items-center justify-center px-2 lg:h-24 lg:justify-between lg:px-8">
          <Logo iconOnly />
          <span className="hidden lg:inline"><LiveDot /></span>
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
          <span className="md:hidden"><Logo /></span>
          <MusicNavigation />
          <div className="flex shrink-0 items-center gap-3">
          <SettingsLink name={user.name} />
          <span className="hidden xl:block"><SignOut /></span>
          </div>
        </div>
        <MusicStage>{children}</MusicStage>
      </div>
      <PlayerBar />
      <MobileNav />
    </div>
    </PlayerProvider>
    </ToastProvider>
  );
}
