"use client";

import * as React from "react";
import Link from "next/link";
import { useSyncExternalStore } from "react";
import { ArrowRight, CheckCircle2, Compass, Library, Link2 } from "lucide-react";
import { ProgressBar } from "@/components/stage-badge";
import { Badge } from "@/components/ui/primitives";
import { formatCount } from "@/lib/format";

const dismissedKey = "mint:setup-nudge-dismissed";
const dismissedEvent = "mint:setup-nudge-dismissed-change";

function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(dismissedEvent, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(dismissedEvent, listener);
  };
}

function isVisible() {
  try {
    return localStorage.getItem(dismissedKey) !== "true";
  } catch {
    return true;
  }
}

export interface SetupNudgeProps {
  linked?: boolean;
  summary?: {
    total: number;
    ready: number;
    active: number;
    failed: number;
  };
}

export function SetupNudge({ linked = false, summary }: SetupNudgeProps) {
  const visible = useSyncExternalStore(subscribe, isVisible, () => true);
  if (!visible) return null;

  const total = summary?.total ?? 0;
  const ready = summary?.ready ?? 0;
  const active = summary?.active ?? 0;
  const progressRatio = total > 0 ? ready / total : 0;

  return (
    <aside
      aria-label={linked ? "Music sync progress" : "Getting started with Mint"}
      className="relative my-8 rounded-2xl border border-line/70 bg-elevated p-5 sm:p-7"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-prose">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={linked ? "positive" : "warning"}>
              {linked ? (
                <>
                  <CheckCircle2 className="size-3.5" aria-hidden />
                  {active > 0 ? "Bringing in your music" : "Connected"}
                </>
              ) : (
                <>
                  <Link2 className="size-3.5" aria-hidden />
                  First-run guide
                </>
              )}
            </Badge>
            {linked && total > 0 && (
              <span className="text-xs font-semibold text-mint tabular" role="status">
                {formatCount(ready)} of {formatCount(total)} playable
              </span>
            )}
          </div>
          <h2 className="mt-2 text-2xl font-bold tracking-tight">
            {linked
              ? active > 0
                ? "Bringing in your music"
                : "Your music is connected"
              : "Welcome to your listening room"}
          </h2>
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-muted">
            {linked
              ? total > 0
                ? `${formatCount(ready)} of ${formatCount(total)} liked songs are ready to play right now${active > 0 ? `, with ${formatCount(active)} still arriving` : ""}.`
                : "Your account is connected. Choose which playlists and likes to bring in from Connected services."
              : "Connect a music service to bring in your playlists and likes, explore the shared catalog, or start playing right away."}
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            try {
              localStorage.setItem(dismissedKey, "true");
            } catch {}
            window.dispatchEvent(new Event(dismissedEvent));
          }}
          className="inline-flex min-h-11 shrink-0 items-center rounded-full px-3 text-sm text-muted hover:bg-hover hover:text-fg"
        >
          Dismiss
        </button>
      </div>

      {linked && total > 0 && (
        <div className="mt-4 max-w-xl">
          <ProgressBar value={progressRatio} />
        </div>
      )}

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        <div className="flex flex-col justify-between rounded-xl border border-line/60 bg-surface/60 p-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold tracking-wider text-faint uppercase">
              <Link2 className="size-4 text-mint" aria-hidden />
              <span>1. Connect a source</span>
            </div>
            <p className="mt-2 text-sm text-muted">
              {linked
                ? "Manage YouTube Music or Spotify playlists and sync preferences."
                : "Link YouTube Music or Spotify in read-only mode to import your playlists and likes."}
            </p>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {!linked ? (
              <>
                <a
                  href="/api/oauth/google/start"
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-mint px-4 text-xs font-bold text-mint-ink hover:bg-mint-strong"
                >
                  Link YouTube Music <ArrowRight className="size-3.5" aria-hidden />
                </a>
                <Link
                  href="/app/settings?section=services"
                  className="inline-flex min-h-11 items-center rounded-full border border-line px-3.5 text-xs font-semibold text-fg hover:bg-hover"
                >
                  All services
                </Link>
              </>
            ) : (
              <Link
                href="/app/settings?section=services"
                className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line px-4 text-xs font-semibold text-fg hover:bg-hover"
              >
                Connected services <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            )}
          </div>
        </div>

        <div className="flex flex-col justify-between rounded-xl border border-line/60 bg-surface/60 p-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold tracking-wider text-faint uppercase">
              <Library className="size-4 text-mint" aria-hidden />
              <span>2. Explore the library</span>
            </div>
            <p className="mt-2 text-sm text-muted">
              Browse albums, artists and songs already on the server, or open Your music to organize playlists.
            </p>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              href="/app/library"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line px-4 text-xs font-semibold text-fg hover:bg-hover"
            >
              Browse library <ArrowRight className="size-3.5" aria-hidden />
            </Link>
            <Link
              href="/app/collection"
              className="inline-flex min-h-11 items-center rounded-full border border-line px-3.5 text-xs font-semibold text-muted hover:bg-hover hover:text-fg"
            >
              Your music
            </Link>
          </div>
        </div>

        <div className="flex flex-col justify-between rounded-xl border border-line/60 bg-surface/60 p-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold tracking-wider text-faint uppercase">
              <Compass className="size-4 text-mint" aria-hidden />
              <span>3. Play & discover</span>
            </div>
            <p className="mt-2 text-sm text-muted">
              Start any track in the browser player, explore mixes made from audio measurements, or browse charts.
            </p>
          </div>
          <div className="mt-4">
            <Link
              href="/app/discover"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line px-4 text-xs font-semibold text-fg hover:bg-hover"
            >
              Open Discover <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          </div>
        </div>
      </div>
    </aside>
  );
}
