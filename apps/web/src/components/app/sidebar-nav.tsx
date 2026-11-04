"use client";

import clsx from "clsx";
import { Compass, Download, Heart, History, Home, Library, ListMusic, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Artwork } from "@/components/artwork";
import { isAppDestinationActive } from "@/lib/app-routes";
import { useRealtime } from "../realtime";

interface Props {
  isAdmin: boolean; pendingRequests: number; activeJobs: number;
  playlists: Array<{ id: string; title: string; syncEnabled: boolean; itemCount: number; artworkUrl: string | null }>;
}
const destinations = [
  { href: "/app", label: "Home", icon: Home },
  { href: "/app/discover", label: "Discover", icon: Compass },
  { href: "/app/library", label: "Library", icon: Library },
  { href: "/app/collections", label: "Your music", icon: ListMusic },
];
const mobileDestinations = [
  ...destinations,
];
export function MobileNav() {
  const path = usePathname();
  return <nav aria-label="Main navigation" className="mobile-navigation flex items-center justify-around border-t border-line bg-background px-2 pb-[var(--safe-area-bottom)] md:hidden">
    {mobileDestinations.map(({ href, label, icon: Icon }) =>
      <Link key={href} href={href} aria-current={isAppDestinationActive(path, href) ? "page" : undefined} className={clsx("flex min-h-16 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-semibold whitespace-nowrap", isAppDestinationActive(path, href) ? "text-fg" : "text-muted hover:text-fg")}>
        <Icon className="size-5" aria-hidden /><span>{label}</span>
      </Link>)}
  </nav>;
}
export function SettingsLink({ name }: { name: string }) {
  const path = usePathname();
  return <Link href="/app/settings" aria-label="Settings" aria-current={isAppDestinationActive(path, "/app/settings") ? "page" : undefined} className="flex min-h-11 items-center gap-3 rounded-full px-2 text-sm text-muted hover:text-fg">
    <span className="hidden sm:inline">{name}</span><span className="grid size-10 place-items-center rounded-full bg-elevated font-bold text-fg">{name.slice(0, 1)}</span>
  </Link>;
}
export function SidebarNav({ isAdmin, pendingRequests, activeJobs, playlists }: Props) {
  const path = usePathname(), [pending, setPending] = useState(pendingRequests);
  useRealtime((event) => { if (event.type === "access-request") setPending(event.data.pending); });
  return <nav className="flex min-h-0 flex-1 flex-col" aria-label="Main navigation">
    <ul className="space-y-1 px-2 lg:px-4">{destinations.map(({ href, label, icon: Icon }) => <li key={href}>
      <Link href={href} aria-label={label} aria-current={isAppDestinationActive(path, href) ? "page" : undefined} className={clsx("flex min-h-12 items-center justify-center gap-4 rounded-xl px-2 text-sm font-semibold transition-colors lg:justify-start lg:px-4", isAppDestinationActive(path, href) ? "bg-elevated text-fg" : "text-muted hover:bg-surface hover:text-fg")}><Icon className="size-5 shrink-0" aria-hidden /><span className="hidden lg:inline">{label}</span></Link>
    </li>)}</ul>
    <div className="mt-9 min-h-0 flex-1 overflow-y-auto px-2 scrollbar-thin lg:px-4">
      <p className="mb-3 hidden min-h-11 items-center gap-3 px-4 text-xs font-semibold text-muted lg:flex"><ListMusic className="size-4" />Your music</p>
      <ul className="space-y-1">
        {[
          { href: "/app/collections", label: "Playlists & Mint likes", icon: Heart },
          { href: "/app/liked", label: "YouTube likes", icon: ListMusic },
          { href: "/app/spotify", label: "Spotify playlists", icon: ListMusic },
          { href: "/app/downloads", label: "Downloads", icon: Download },
          { href: "/app/history", label: "Listening history", icon: History },
        ].map(({ href, label, icon: Icon }) => <li key={href}><Link href={href} aria-label={label} aria-current={isAppDestinationActive(path, href) ? "page" : undefined} className={clsx("flex min-h-11 items-center justify-center gap-3 rounded-xl px-2 text-sm hover:bg-surface lg:justify-start lg:px-4", isAppDestinationActive(path, href) ? "text-fg" : "text-muted hover:text-fg")}><Icon className="size-4 shrink-0" aria-hidden /><span className="hidden lg:inline">{label}</span></Link></li>)}
        {playlists.slice(0, 6).map((playlist) => <li key={playlist.id}>
          <Link href={`/app/playlists/${playlist.id}`} aria-label={playlist.title} className="mt-2 flex items-center justify-center gap-3 rounded-xl p-2 hover:bg-surface lg:justify-start lg:p-3">
            <Artwork track={{ artworkUrl: playlist.artworkUrl ?? "" }} className="size-10 shrink-0 rounded-md" />
            <span className="hidden min-w-0 lg:block"><span className="block truncate text-sm font-medium">{playlist.title}</span><span className="block text-xs text-faint">{playlist.itemCount} songs · YouTube</span></span>
          </Link>
        </li>)}
      </ul>
    </div>
    <div className="mt-5 border-t border-line/60 p-2 lg:p-4">
      {(activeJobs > 0 || pending > 0) && <Link href={isAdmin && pending ? "/app/admin" : "/app/jobs"} aria-label={pending ? `${pending} awaiting approval` : `${activeJobs} songs on the way`} className="mb-2 flex min-h-11 items-center justify-center gap-2 px-2 text-xs text-muted lg:justify-start lg:px-4">
        <span className={`size-1.5 shrink-0 rounded-full ${pending ? "bg-warn" : "bg-mint"}`} /><span className="hidden lg:inline">{pending ? `${pending} awaiting approval` : `${activeJobs} songs on the way`}</span>
      </Link>}
      <Link href="/app/settings" aria-label="Settings & management" aria-current={isAppDestinationActive(path, "/app/settings") ? "page" : undefined} className="flex min-h-12 items-center justify-center gap-4 rounded-xl px-2 text-sm font-semibold text-muted hover:bg-surface hover:text-fg lg:justify-start lg:px-4"><Settings className="size-5 shrink-0" aria-hidden /><span className="hidden lg:inline">Settings & management</span></Link>
    </div>
  </nav>;
}
