import { LogOut } from "lucide-react";
import Link from "next/link";
import { logout } from "@/app/actions/auth";
import { SidebarNav } from "@/components/app/sidebar-nav";
import { LiveDot } from "@/components/live-dot";
import { Logo } from "@/components/logo";
import { PlayerBar } from "@/components/player-bar";
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
    <div className="grid h-dvh grid-rows-[auto_minmax(0,1fr)_auto] gap-2 bg-bg p-2 lg:grid-cols-[18rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)_auto]">
      <aside className="hidden min-h-0 flex-col gap-2 lg:flex">
        <div className="flex items-center justify-between rounded-lg bg-surface px-5 py-4">
          <Logo />
          <LiveDot />
        </div>
        <SidebarNav
          isAdmin={user.role === "admin"}
          pendingRequests={pending}
          activeJobs={summary.active}
          playlists={playlists.map((p) => ({ id: p.id, title: p.title, syncEnabled: p.syncEnabled, itemCount: p.itemCount }))}
        />
      </aside>

      {/* Compact top bar below lg: the sidebar collapses into a scrollable row. */}
      <header className="flex items-center gap-4 overflow-x-auto rounded-lg bg-surface px-4 py-3 text-sm font-semibold text-muted scrollbar-thin lg:hidden">
        <Logo />
        <Link href="/app" className="hover:text-fg">Home</Link>
        <Link href="/app/liked" className="hover:text-fg">Liked</Link>
        <Link href="/app/library" className="hover:text-fg">Library</Link>
        <Link href="/app/jobs" className="hover:text-fg">Jobs</Link>
        <Link href="/app/workers" className="hover:text-fg">Workers</Link>
        <Link href="/app/settings" className="hover:text-fg">Settings</Link>
        {user.role === "admin" && <Link href="/app/admin" className="hover:text-fg">Admin{pending ? ` (${pending})` : ""}</Link>}
      </header>

      <div className="relative min-h-0 overflow-y-auto rounded-lg bg-surface scrollbar-thin">
        <div className="sticky top-0 z-20 flex h-14 items-center justify-end gap-3 bg-surface/90 px-6 backdrop-blur-md">
          <span className="text-sm text-muted">{user.name}</span>
          <form action={logout}>
            <button type="submit" className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold text-muted transition hover:bg-elevated hover:text-fg">
              <LogOut className="size-4" aria-hidden /> Sign out
            </button>
          </form>
        </div>
        <main className="px-6 pb-12">{children}</main>
      </div>

      <PlayerBar className="rounded-lg border-t-0 lg:col-span-2" />
    </div>
  );
}
