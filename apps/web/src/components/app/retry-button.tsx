"use client";

import clsx from "clsx";
import { FastForward, Loader2, RotateCcw } from "lucide-react";
import { useState, useTransition } from "react";
import { retryTrack } from "@/app/actions/member";

export function RetryButton({ trackId, forceCobalt = false }: { trackId: string; forceCobalt?: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const label = forceCobalt ? "Skip the release search and rip from YouTube" : "Retry";
  const Icon = pending ? Loader2 : forceCobalt ? FastForward : RotateCcw;
  return (
    <button
      type="button"
      title={error ?? label}
      aria-label={error ?? label}
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await retryTrack(trackId, forceCobalt);
          setError(res.error ?? null);
        })
      }
      className={clsx("grid size-8 place-items-center rounded-full transition hover:bg-elevated hover:text-fg disabled:opacity-60", error ? "text-danger" : "text-muted")}
    >
      <Icon className={pending ? "size-4 animate-spin" : "size-4"} aria-hidden />
    </button>
  );
}
