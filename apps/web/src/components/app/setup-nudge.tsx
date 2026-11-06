"use client";

import * as React from "react";
import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { ArrowRight, Compass, Library } from "lucide-react";

const dismissedKey = "mint:welcome-dismissed";
const dismissedEvent = "mint:setup-nudge-dismissed-change";

function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(dismissedEvent, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(dismissedEvent, listener);
  };
}

function isVisible(memberId?: string) {
  try {
    return localStorage.getItem(`${dismissedKey}:${memberId ?? "member"}`) !== "true";
  } catch {
    return true;
  }
}

export interface SetupNudgeProps {
  memberId?: string;
}

export function SetupNudge({ memberId }: SetupNudgeProps) {
  const visible = useSyncExternalStore(subscribe, () => isVisible(memberId), () => true);
  const [dismissed, setDismissed] = useState(false);
  if (!visible || dismissed) return null;

  return (
    <aside
      aria-label="Getting started with Mint"
      className="my-10 border-y border-line py-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-prose">
          <h2 className="text-2xl font-bold tracking-tight">Welcome to your listening room</h2>
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-muted">
            Find a song, press play, and make yourself at home. No music-service account or setup needed.
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            setDismissed(true);
            try {
              localStorage.setItem(`${dismissedKey}:${memberId ?? "member"}`, "true");
            } catch {}
            window.dispatchEvent(new Event(dismissedEvent));
          }}
          className="inline-flex min-h-11 shrink-0 items-center rounded-full px-3 text-sm text-muted hover:bg-hover hover:text-fg"
        >
          Got it
        </button>
      </div>

      <div className="mt-5 flex flex-wrap gap-3">
        <Link
          href="/app/library"
          className="inline-flex min-h-11 items-center gap-2 rounded-full bg-mint px-5 text-sm font-bold text-mint-ink hover:bg-mint-strong"
        >
          <Library className="size-4" aria-hidden />
          Find your first song <ArrowRight className="size-4" aria-hidden />
        </Link>
        <Link
          href="/app/discover"
          className="inline-flex min-h-11 items-center gap-2 rounded-full bg-elevated px-5 text-sm font-semibold hover:bg-hover"
        >
          <Compass className="size-4" aria-hidden />
          Explore something new
        </Link>
      </div>
      <p className="mt-4 max-w-prose text-sm text-muted">
        Save favorites with the heart, organize them in Your music, and tune your sound in Settings.
      </p>
    </aside>
  );
}
