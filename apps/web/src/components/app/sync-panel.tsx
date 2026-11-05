"use client";

import type { SyncState } from "@mint/core/events";
import { Loader2, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { syncNow } from "@/app/actions/member";
import { timeAgo } from "@/lib/format";
import { useRealtime } from "../realtime";

export function SyncPanel({ initial }: { initial: SyncState }) {
  const [state, setState] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  useRealtime((e) => {
    if (e.type === "sync") {
      setState((s) => ({ ...s, ...e.data }));
      if (e.data.status !== "syncing") router.refresh();
    }
  });
  const syncing = state.status === "syncing";

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <button
        type="button"
        disabled={syncing || pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const res = await syncNow();
            if (res.error) setError(res.error);
            else setState((s) => ({ ...s, status: "syncing", message: "Bringing in your music" }));
          })
        }
        className="inline-flex min-h-11 items-center gap-2 rounded-full bg-fg px-5 text-sm font-bold text-bg transition hover:bg-fg/90 disabled:cursor-wait disabled:opacity-70"
      >
        {syncing || pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
        {syncing ? "Bringing in your music…" : "Sync now"}
      </button>
      <p className="text-sm text-muted" role="status">
        {error ? (
          <span className="text-danger">{error}</span>
        ) : state.status === "error" ? (
          <span className="text-danger">Last sync failed: {state.message ?? "unknown error"}</span>
        ) : syncing ? (
          <>
            Bringing in your music{state.message ? ` · ${state.message}` : ""}
            {state.found != null && <> · {state.found} found</>}
          </>
        ) : (
          <>
            Last synced {timeAgo(state.lastSyncedAt)}
            {state.added ? <> · {state.added} new</> : null}
          </>
        )}
      </p>
    </div>
  );
}
