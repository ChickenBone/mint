"use client";

import clsx from "clsx";
import { Artwork } from "@/components/artwork";
import { Activity, Heart, Home, Library, ListMusic, Menu, Music2, Server, Settings, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useRealtime } from "../realtime";
import { Logo } from "@/components/logo";

interface Props {
  isAdmin: boolean;
  pendingRequests: number;
  activeJobs: number;
  playlists: Array<{ id: string; title: string; syncEnabled: boolean; itemCount: number; artworkUrl: string | null }>;
}

export function MobileNav({ isAdmin, pendingRequests }: Pick<Props, "isAdmin" | "pendingRequests">) {
  const path = usePathname();
  const links = [
    { href: "/app", label: "Home" }, { href: "/app/liked", label: "Liked songs" },
    { href: "/app/jobs", label: "Jobs" }, { href: "/app/workers", label: "Workers" }, { href: "/app/settings", label: "Settings" },
    ...(isAdmin ? [{ href: "/app/admin", label: `Admin${pendingRequests ? ` (${pendingRequests})` : ""}` }] : []),
  ];
  return <header className="relative z-40 flex h-14 items-center justify-between gap-3 rounded-lg bg-surface px-4 text-sm font-semibold lg:hidden">
    <Logo />
    <Link href="/app/music" aria-current={path === "/app/music" ? "page" : undefined} className={path === "/app/music" ? "text-mint" : "text-muted hover:text-fg"}>Music</Link>
    <Link href="/app/library" aria-current={path === "/app/library" ? "page" : undefined} className={path === "/app/library" ? "text-mint" : "text-muted hover:text-fg"}>Library</Link>
    <details className="group" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false;
    }} onKeyDown={(event) => {
      if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); }
    }}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-full p-2 text-muted hover:bg-hover hover:text-fg [&::-webkit-details-marker]:hidden"><Menu className="size-5" /><span className="sr-only">More pages</span></summary>
      <nav aria-label="More pages" className="absolute top-full right-0 mt-2 w-56 rounded-lg bg-elevated p-2 shadow-[0_12px_30px_-8px_#000] ring-1 ring-line">
        {links.map(({ href, label }) =>
          <Link key={href} href={href} aria-current={path === href ? "page" : undefined} onClick={(event) => { const details = event.currentTarget.closest("details"); if (details) details.open = false; }}
            className={clsx("block rounded-md px-3 py-3 hover:bg-hover", path === href ? "text-mint" : "text-muted hover:text-fg")}>{label}</Link>)}
      </nav>
    </details>
  </header>;
}

export function SidebarNav({ isAdmin, pendingRequests, activeJobs, playlists }: Props) {
  const path = usePathname();
  const [pending, setPending] = useState(pendingRequests);
  useRealtime((e) => {
    if (e.type === "access-request") setPending(e.data.pending);
  });

  const items = [
    { href: "/app", label: "Home", icon: Home, exact: true },
    { href: "/app/library", label: "Library", icon: Library },
    { href: "/app/music", label: "Music", icon: Music2 },
    { href: "/app/jobs", label: "Jobs", icon: Activity, badge: activeJobs || undefined },
    { href: "/app/workers", label: "Workers", icon: Server },
    { href: "/app/settings", label: "Settings", icon: Settings },
    ...(isAdmin ? [{ href: "/app/admin", label: "Admin", icon: ShieldCheck, badge: pending || undefined, alert: pending > 0 }] : []),
  ];
  const isActive = (href: string, exact?: boolean) => (exact ? path === href : path === href || path.startsWith(`${href}/`));

  return (
    <nav className="flex min-h-0 flex-1 flex-col gap-2" aria-label="Dashboard">
      <ul className="rounded-lg bg-surface p-2">
        {items.map(({ href, label, icon: Icon, exact, badge, alert }) => (
          <li key={href}>
            <Link
              href={href}
              aria-current={isActive(href, exact) ? "page" : undefined}
              className={clsx(
                "flex items-center gap-4 rounded-md px-3 py-2.5 font-semibold transition-colors",
                isActive(href, exact) ? "text-fg" : "text-muted hover:text-fg",
              )}
            >
              <Icon className="size-5" aria-hidden />
              <span className="flex-1">{label}</span>
              {badge != null && (
                <span className={clsx("rounded-full px-2 py-0.5 text-xs tabular", alert ? "bg-mint text-mint-ink" : "bg-hover text-muted")}>{badge}</span>
              )}
            </Link>
          </li>
        ))}
      </ul>

      <div className="flex min-h-0 flex-1 flex-col rounded-lg bg-surface p-2">
        <p className="flex items-center gap-3 px-3 py-2.5 font-semibold text-muted">
          <ListMusic className="size-5" aria-hidden /> Your music
        </p>
        <ul className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          <li>
            <Link
              href="/app/liked"
              aria-current={path === "/app/liked" ? "page" : undefined}
              className={clsx("flex items-center gap-3 rounded-md p-2 transition-colors hover:bg-hover", path === "/app/liked" && "bg-hover")}
            >
              <span className="grid size-12 place-items-center rounded bg-gradient-to-br from-mint to-[#1d6b4e] text-mint-ink">
                <Heart className="size-5" fill="currentColor" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block truncate font-medium">Liked songs</span>
                <span className="block truncate text-sm text-muted">Synced from YouTube Music</span>
              </span>
            </Link>
          </li>
          {playlists.map((p) => {
            const href = `/app/playlists/${p.id}`;
            return (
              <li key={p.id}>
                <Link
                  href={href}
                  aria-current={path === href ? "page" : undefined}
                  className={clsx("flex items-center gap-3 rounded-md p-2 transition-colors hover:bg-hover", path === href && "bg-hover")}
                >
                  {p.artworkUrl ? (
                    <Artwork track={{ artworkUrl: p.artworkUrl }} className="size-12 rounded" />
                  ) : (
                    <span className="grid size-12 shrink-0 place-items-center rounded bg-elevated text-faint">
                      <ListMusic className="size-5" aria-hidden />
                    </span>
                  )}
                  <span className="min-w-0">
                    <span className={clsx("block truncate font-medium", !p.syncEnabled && "text-muted")}>{p.title}</span>
                    <span className="block truncate text-sm text-muted">
                      {p.syncEnabled ? "Syncing" : "Not synced"} · {p.itemCount} songs
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
