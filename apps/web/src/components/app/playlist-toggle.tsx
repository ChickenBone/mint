"use client";

import clsx from "clsx";
import { useOptimistic, useTransition } from "react";
import { setPlaylistSync } from "@/app/actions/member";

export function PlaylistToggle({ id, enabled, label }: { id: string; enabled: boolean; label: string }) {
  const [optimistic, setOptimistic] = useOptimistic(enabled);
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={optimistic}
      aria-label={`Sync ${label} to Plex`}
      disabled={pending}
      onClick={() =>
        start(async () => {
          setOptimistic(!optimistic);
          await setPlaylistSync(id, !optimistic);
        })
      }
      className={clsx(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-70",
        optimistic ? "bg-mint" : "bg-hover",
      )}
    >
      <span className={clsx("size-5 rounded-full bg-fg shadow transition-transform duration-200 ease-out-expo", optimistic ? "translate-x-5.5" : "translate-x-0.5")} />
    </button>
  );
}
