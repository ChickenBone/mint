"use client";

import clsx from "clsx";
import { ArrowLeft, Cpu, Flag, Home, Library, ListChecks, ListMusic, Pin, Search, Settings, ShieldCheck, Sparkles, Users, Waves } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import React, { useEffect, useState } from "react";
import { Artwork } from "@/components/artwork";
import { Badge } from "@/components/ui/primitives";
import { isAdminWorkspace, isAppDestinationActive, listeningDestinations, resolveManageTab } from "@/lib/app-routes";
import { musicRequest, type CollectionList } from "@/lib/music-client";
import { useRealtime } from "../realtime";

interface Props {
  isAdmin: boolean;
  pendingRequests: number;
  playlists?: SidebarPlaylist[];
  playlistsError?: boolean;
}

type SidebarPlaylist = {
  id: string;
  title: string;
  artworkUrl: string | null;
  smart: boolean;
  role: "owner" | "editor";
  pinned: boolean;
};

export function SidebarPlaylistLinks({ playlists, path }: { playlists: SidebarPlaylist[]; path: string }) {
  return (
    <ul className="space-y-1" aria-label="Mint playlists">
      {playlists.map((playlist) => {
        const href = `/app/collection/${playlist.id}`;
        return (
          <li key={playlist.id}>
            <Link href={href} aria-label={playlist.title} title={playlist.title}
              aria-current={path === href ? "page" : undefined}
              className={clsx("flex min-h-14 min-w-0 items-center justify-center gap-3 rounded-xl px-2 py-2 lg:justify-start lg:px-4",
                path === href ? "bg-elevated text-fg" : "text-muted hover:bg-surface hover:text-fg")}>
              {playlist.artworkUrl ? <Artwork track={{ artworkUrl: playlist.artworkUrl }} className="size-10 rounded-none" /> :
                <span className="grid size-10 shrink-0 place-items-center bg-elevated">
                  {playlist.smart ? <Sparkles className="size-5" aria-hidden /> : <ListMusic className="size-5" aria-hidden />}
                </span>}
              <span className="hidden min-w-0 flex-1 lg:block">
                <span className="block truncate text-sm font-semibold">{playlist.title}</span>
                <span className="flex items-center gap-1.5 text-xs text-muted">
                  {playlist.pinned && <><Pin className="size-3 shrink-0" aria-hidden /><span className="sr-only">Pinned. </span></>}
                  {playlist.smart ? "Smart playlist" : playlist.role === "editor" ? "Collaborative playlist" : "Playlist"}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function SidebarPlaylists({ initial, initialError = false }: { initial: SidebarPlaylist[]; initialError?: boolean }) {
  const path = usePathname();
  const [playlists, setPlaylists] = useState(initial);
  const [error, setError] = useState(initialError);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    let loading = false;
    const refresh = async () => {
      if (loading || document.visibilityState === "hidden") return;
      loading = true;
      try {
        const result = await musicRequest<CollectionList>("collections");
        if (active) {
          setPlaylists(result.collections.map(({ id, title, artworkUrl, rules, role, pinned }) => ({
            id, title, artworkUrl, smart: Boolean(rules), role, pinned,
          })));
          setError(false);
        }
      } catch {
        if (active) setError(true);
      } finally {
        loading = false;
      }
    };
    void refresh();
    // Collection mutations have no realtime event; refresh on navigation and while visible.
    const timer = window.setInterval(() => void refresh(), 5_000);
    const onVisible = () => void refresh();
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [path, retry]);

  return (
    <section className="mt-5 min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-line/60 px-2 pt-3 lg:px-4" aria-label="Playlists">
      <Link href="/app/collection" aria-label="View all playlists"
        className="flex min-h-11 items-center justify-center gap-3 rounded-xl px-2 text-sm font-semibold text-muted hover:bg-surface hover:text-fg lg:justify-start lg:px-4">
        <ListMusic className="size-5 shrink-0 lg:hidden" aria-hidden />
        <span className="hidden lg:inline">Playlists</span>
      </Link>
      <SidebarPlaylistLinks playlists={playlists} path={path} />
      {error ? (
        <div className="px-2 py-2 text-xs text-muted lg:px-4">
          <p role="status" className="sr-only lg:not-sr-only">Playlists couldn’t refresh.</p>
          <button type="button" aria-label="Retry loading playlists" onClick={() => setRetry((value) => value + 1)}
            className="min-h-11 w-full rounded-lg text-sm font-semibold hover:bg-hover">Retry</button>
        </div>
      ) : playlists.length === 0 && <p className="hidden px-4 py-2 text-xs text-muted lg:block">Your playlists will appear here.</p>}
    </section>
  );
}

const destinationIcons = { "/app": Home, "/app/search": Search, "/app/collection": Library };
const destinations = listeningDestinations.map((destination) => ({ ...destination, icon: destinationIcons[destination.href] }));

const adminDestinations = [
  { href: "/app/manage", tab: "requests", label: "Members", icon: Users, group: "People" },
  { href: "/app/manage?tab=reports", tab: "reports", label: "Reports", icon: Flag, group: "People" },
  { href: "/app/manage?tab=jobs", tab: "jobs", label: "Activity", icon: ListChecks, group: "Operations" },
  { href: "/app/manage?tab=workers", tab: "workers", label: "Workers", icon: Cpu, group: "Operations" },
  { href: "/app/manage?tab=analysis", tab: "analysis", label: "Analysis", icon: Waves, group: "Operations" },
  { href: "/app/manage?tab=matching", tab: "matching", label: "Matching", icon: Sparkles, group: "Operations" },
] as const;

const adminDestinationGroups = ["People", "Operations"].map((group) => ({
  label: group,
  links: adminDestinations.filter((destination) => destination.group === group),
}));

export function MobileNav({ isAdmin = false }: { isAdmin?: boolean }) {
  const path = usePathname();
  const searchParams = useSearchParams();
  const adminArea = isAdminWorkspace(path, isAdmin);
  const tab = resolveManageTab(searchParams.get("tab"));
  const links = adminArea ? adminDestinations : destinations;
  return (
    <nav
      aria-label={adminArea ? "Admin navigation" : "Main navigation"}
      className="mobile-navigation flex items-center justify-around border-t border-line bg-background px-2 pb-[var(--safe-area-bottom)] md:hidden"
    >
      {links.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          aria-current={(adminArea ? adminDestinations.find((d) => d.href === href)?.tab === tab : isAppDestinationActive(path, href)) ? "page" : undefined}
          className={clsx(
            "flex min-h-16 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-semibold whitespace-nowrap",
            (adminArea ? adminDestinations.find((d) => d.href === href)?.tab === tab : isAppDestinationActive(path, href)) ? "text-fg" : "text-muted hover:text-fg",
          )}
        >
          <Icon className="size-5" aria-hidden />
          <span>{label}</span>
        </Link>
      ))}
    </nav>
  );
}

export function SettingsLink({ name, pendingRequests = 0 }: { name: string; pendingRequests?: number }) {
  const path = usePathname();
  return (
    <Link
      href="/app/settings"
      aria-label={pendingRequests > 0 ? `Settings (${pendingRequests} pending in Admin portal)` : "Settings"}
      aria-current={isAppDestinationActive(path, "/app/settings") ? "page" : undefined}
      className="relative flex min-h-11 items-center gap-3 rounded-full px-2 text-sm text-muted hover:text-fg"
    >
      <span className="hidden max-w-40 truncate sm:inline">{name}</span>
      <span className="grid size-10 place-items-center rounded-full bg-elevated font-bold text-fg">{name.slice(0, 1)}</span>
      {pendingRequests > 0 && (
        <span
          aria-hidden
          className="absolute top-0 right-1 grid min-w-5 place-items-center rounded-full bg-warn px-1.5 py-0.5 text-[10px] font-bold text-bg md:hidden"
        >
          {pendingRequests}
        </span>
      )}
    </Link>
  );
}

export function SidebarNav({ isAdmin, pendingRequests, playlists = [], playlistsError = false }: Props) {
  const path = usePathname();
  const searchParams = useSearchParams();
  const [pending, setPending] = useState(pendingRequests);
  useRealtime((event) => {
    if (event.type === "access-request") setPending(event.data.pending);
  });

  if (isAdminWorkspace(path, isAdmin)) {
    const tab = resolveManageTab(searchParams.get("tab"));
    return (
      <nav className="flex min-h-0 flex-1 flex-col px-2 lg:px-4" aria-label="Admin navigation">
        <div className="mb-6 hidden px-4 lg:block">
          <p className="flex items-center gap-2 text-lg font-bold"><ShieldCheck className="size-5 text-muted" aria-hidden />Admin portal</p>
          <p className="mt-1 text-xs text-muted">Keep the listening room running.</p>
        </div>
        {adminDestinationGroups.map(({ label: group, links }) => (
          <div key={group} className="mb-5">
            <p className="mb-2 hidden px-4 text-[10px] font-bold tracking-[0.12em] text-faint uppercase lg:block">{group}</p>
            <ul className="space-y-1">
              {links.map(({ href, tab: value, label, icon: Icon }) => (
                <li key={href}>
                  <Link href={href} aria-label={label} aria-current={tab === value ? "page" : undefined}
                    className={clsx("flex min-h-12 items-center justify-center gap-3 rounded-xl border px-2 text-sm font-semibold lg:justify-start lg:px-4",
                      tab === value ? "border-line/70 bg-elevated text-fg" : "border-transparent text-muted hover:bg-surface hover:text-fg")}>
                    <Icon className="size-5 shrink-0" aria-hidden />
                    <span className="hidden lg:inline">{label}</span>
                    {value === "requests" && pending > 0 && <Badge tone="warning">{pending}</Badge>}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <Link href="/app/settings?section=services" aria-label="Connected services"
          className="mt-5 flex min-h-12 items-center justify-center gap-3 rounded-xl px-2 text-sm text-muted hover:bg-surface hover:text-fg lg:justify-start lg:px-4">
          <Settings className="size-5 shrink-0" aria-hidden />
          <span className="hidden lg:inline">Connected services</span>
        </Link>
        <Link href="/app" aria-label="Back to music"
          className="mt-auto mb-4 flex min-h-12 items-center justify-center gap-3 rounded-xl bg-elevated px-2 text-sm font-semibold hover:bg-hover lg:justify-start lg:px-4">
          <ArrowLeft className="size-5 shrink-0" aria-hidden />
          <span className="hidden lg:inline">Back to music</span>
        </Link>
      </nav>
    );
  }

  return (
    <nav className="flex min-h-0 flex-1 flex-col" aria-label="Main navigation">
      <ul className="shrink-0 space-y-1 px-2 lg:px-4">
        {destinations.map(({ href, label, icon: Icon }) => (
          <li key={href}>
            <Link
              href={href}
              aria-label={label}
              aria-current={isAppDestinationActive(path, href) ? "page" : undefined}
              className={clsx(
                "flex min-h-12 items-center justify-center gap-4 rounded-xl px-2 text-sm font-semibold transition-colors lg:justify-start lg:px-4",
                isAppDestinationActive(path, href) ? "bg-elevated text-fg" : "text-muted hover:bg-surface hover:text-fg",
              )}
            >
              <Icon className="size-5 shrink-0" aria-hidden />
              <span className="hidden lg:inline">{label}</span>
            </Link>
          </li>
        ))}
      </ul>

      <SidebarPlaylists initial={playlists} initialError={playlistsError} />

      <div className="mt-auto shrink-0 space-y-1 p-2 lg:p-4">
        {isAdmin && (
          <Link
            href="/app/manage"
            aria-label={pending > 0 ? `Admin portal (${pending} pending)` : "Admin portal"}
            aria-current={isAppDestinationActive(path, "/app/manage") ? "page" : undefined}
            className={clsx(
              "flex min-h-12 items-center justify-center gap-3 rounded-xl px-2 text-sm font-semibold transition-colors lg:justify-between lg:px-4",
              isAppDestinationActive(path, "/app/manage") ? "bg-elevated text-fg" : "text-muted hover:bg-surface hover:text-fg",
            )}
          >
            <span className="flex items-center gap-4">
              <ShieldCheck className="size-5 shrink-0" aria-hidden />
              <span className="hidden lg:inline">Admin portal</span>
            </span>
            {pending > 0 && (
              <Badge tone="warning" className="inline-flex">
                {pending}
              </Badge>
            )}
          </Link>
        )}
      </div>
    </nav>
  );
}
