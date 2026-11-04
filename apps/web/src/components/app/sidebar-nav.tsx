"use client";

import clsx from "clsx";
import { CircleUserRound, Compass, Download, Heart, History, Home, Library, ListMusic, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Artwork } from "@/components/artwork";
import { useRealtime } from "../realtime";

interface Props {
  isAdmin: boolean; pendingRequests: number; activeJobs: number;
  playlists: Array<{ id: string; title: string; syncEnabled: boolean; itemCount: number; artworkUrl: string | null }>;
}
const destinations = [
  { href: "/app", label: "Home", icon: Home },
  { href: "/app/discover", label: "Discover", icon: Compass },
  { href: "/app/music?view=library&type=album", label: "Library", icon: Library },
];
const mobileDestinations = [
  ...destinations,
  { href: "/app/collections", label: "Collection", icon: ListMusic },
  { href: "/app/settings", label: "You", icon: CircleUserRound },
];
function active(path: string, href: string) {
  return href.startsWith("/app/music") ? path === "/app/music" || path === "/app/library" : path === href || href !== "/app" && path.startsWith(`${href}/`);
}
export function MobileNav() {
  const path = usePathname();
  return <nav aria-label="Main navigation" className="mobile-navigation flex items-center justify-around border-t border-line bg-background px-2 pb-[var(--safe-area-bottom)] lg:hidden">
    {mobileDestinations.map(({ href, label, icon: Icon }) =>
      <Link key={href} href={href} aria-label={label === "Collection" ? "Your collection" : undefined} aria-current={active(path, href) ? "page" : undefined} className={clsx("flex min-h-16 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-semibold whitespace-nowrap", active(path, href) ? "text-fg" : "text-muted hover:text-fg")}>
        <Icon className="size-5" aria-hidden /><span>{label}</span>
      </Link>)}
  </nav>;
}
export function SidebarNav({ isAdmin, pendingRequests, activeJobs, playlists }: Props) {
  const path = usePathname(), [pending, setPending] = useState(pendingRequests);
  useRealtime((event) => { if (event.type === "access-request") setPending(event.data.pending); });
  return <nav className="flex min-h-0 flex-1 flex-col" aria-label="Main navigation">
    <ul className="space-y-1 px-4">{destinations.map(({ href, label, icon: Icon }) => <li key={href}>
      <Link href={href} aria-current={active(path, href) ? "page" : undefined} className={clsx("flex min-h-12 items-center gap-4 rounded-xl px-4 text-sm font-semibold transition-colors", active(path, href) ? "bg-elevated text-fg" : "text-muted hover:bg-surface hover:text-fg")}><Icon className="size-5" aria-hidden />{label}</Link>
    </li>)}</ul>
    <div className="mt-9 min-h-0 flex-1 overflow-y-auto px-4 scrollbar-thin">
      <Link href="/app/collections" className="mb-3 flex min-h-11 items-center gap-3 px-4 text-xs font-semibold text-muted hover:text-fg"><ListMusic className="size-4" />Your collection</Link>
      <ul className="space-y-1">
        {[
          { href: "/app/collections", label: "Playlists & Mint likes", icon: Heart },
          { href: "/app/liked", label: "YouTube likes", icon: ListMusic },
          { href: "/app/spotify", label: "Spotify playlists", icon: ListMusic },
          { href: "/app/downloads", label: "Downloads", icon: Download },
          { href: "/app/history", label: "Listening history", icon: History },
        ].map(({ href, label, icon: Icon }) => <li key={href}><Link href={href} aria-current={active(path, href) ? "page" : undefined} className={clsx("flex min-h-11 items-center gap-3 rounded-xl px-4 text-sm hover:bg-surface", active(path, href) ? "text-fg" : "text-muted hover:text-fg")}><Icon className="size-4" aria-hidden />{label}</Link></li>)}
        {playlists.slice(0, 6).map((playlist) => <li key={playlist.id}>
          <Link href={`/app/playlists/${playlist.id}`} className="mt-2 flex items-center gap-3 rounded-xl p-3 hover:bg-surface">
            <Artwork track={{ artworkUrl: playlist.artworkUrl ?? "" }} className="size-10 shrink-0 rounded-md" />
            <span className="min-w-0"><span className="block truncate text-sm font-medium">{playlist.title}</span><span className="block text-xs text-faint">{playlist.itemCount} songs · YouTube</span></span>
          </Link>
        </li>)}
      </ul>
    </div>
    <div className="mt-5 border-t border-line/60 p-4">
      {(activeJobs > 0 || pending > 0) && <Link href={isAdmin && pending ? "/app/admin" : "/app/jobs"} className="mb-2 flex min-h-11 items-center gap-2 px-4 text-xs text-muted">
        <span className={`size-1.5 rounded-full ${pending ? "bg-warn" : "bg-mint"}`} />{pending ? `${pending} awaiting approval` : `${activeJobs} songs on the way`}
      </Link>}
      <Link href="/app/settings" aria-current={path === "/app/settings" ? "page" : undefined} className="flex min-h-12 items-center gap-4 rounded-xl px-4 text-sm font-semibold text-muted hover:bg-surface hover:text-fg"><Settings className="size-5" aria-hidden />Settings & management</Link>
    </div>
  </nav>;
}
