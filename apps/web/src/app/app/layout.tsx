import { getDb } from "@mint/core/db";
import { AcquisitionAlerts } from "@/components/app/acquisition-alerts";
import { MobileNav, PendingRequestsProvider, SettingsLink, SidebarNav } from "@/components/app/sidebar-nav";
import { MusicStage, PlayerBar, PlayerProvider, SearchShortcut } from "@/components/app/player";
import { Logo } from "@/components/logo";
import { ToastProvider } from "@/components/ui/toast";
import { requireUser } from "@/lib/auth";
import { getPendingCount } from "@/lib/data";
import { listCollections } from "@/lib/music-store";
import { targetAuthentication, targetAuthenticationEnabled } from "@/lib/target-auth";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const targetMode = targetAuthenticationEnabled();
  let pending: number | null = 0;
  if (user.role === "admin") {
    if (targetMode) {
      try {
        const { sdk, signal } = await targetAuthentication();
        pending = await sdk.accounts.pendingAccessRequestCount({ signal });
      } catch {
        console.error("TargetPendingRequestsUnavailable");
        pending = null;
      }
    } else {
      pending = await getPendingCount();
    }
  }
  const playlists = targetMode ? { items: [], error: true } : await listCollections(getDb(), user.id)
    .then(({ collections }) => ({
      items: collections.map(({ id, title, artworkUrl, rules, role, pinned }) => ({
        id, title, artworkUrl, smart: Boolean(rules), role, pinned,
      })),
      error: false,
    }))
    .catch((error: unknown) => {
      console.error("Sidebar playlists could not load", error instanceof Error ? error.message : "Unknown failure");
      return { items: [], error: true };
    });

  return (
    <ToastProvider>
    <PendingRequestsProvider key={user.id} enabled={targetMode && user.role === "admin"} initial={pending}>
    <AcquisitionAlerts />
    <PlayerProvider memberId={user.id}>
    <div className="app-shell grid h-dvh grid-rows-[minmax(0,1fr)_auto_auto] bg-bg md:grid-cols-[5rem_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)_auto] lg:grid-cols-[16rem_minmax(0,1fr)]">
      <a href="#listening-content" className="skip-link">Skip to content</a>
      <SearchShortcut />
      <aside className="hidden min-h-0 flex-col border-r border-line/60 md:flex">
        <div className="flex h-16 shrink-0 items-center justify-center px-2 lg:justify-start lg:px-8">
          <Logo iconOnly />
        </div>
        <SidebarNav
          key={user.id}
          isAdmin={user.role === "admin"}
          pendingRequests={pending}
          playlists={playlists.items}
          playlistsError={playlists.error}
          playlistsUnavailable={targetMode}
        />
      </aside>

      <div className="relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-surface">
        <div className="listening-topbar flex h-16 shrink-0 items-center justify-between gap-3 px-5 sm:px-10 xl:px-12">
          <span className="md:hidden"><Logo /></span>
          <div className="flex shrink-0 items-center gap-3">
          <SettingsLink name={user.name} pendingRequests={pending} />
          </div>
        </div>
        <MusicStage>{children}</MusicStage>
      </div>
      <PlayerBar />
      <MobileNav isAdmin={user.role === "admin"} />
    </div>
    </PlayerProvider>
    </PendingRequestsProvider>
    </ToastProvider>
  );
}
