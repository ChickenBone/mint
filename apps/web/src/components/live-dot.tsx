"use client";

import clsx from "clsx";
import { useRealtimeStatus } from "./realtime";

export function LiveDot({ className }: { className?: string }) {
  const status = useRealtimeStatus();
  const label = status === "live" ? "Live" : status === "connecting" ? "Connecting" : "Reconnecting";
  return (
    <span className={clsx("inline-flex items-center gap-1.5 text-xs font-medium text-muted", className)} role="status">
      <span className="relative flex size-2">
        {status === "live" && <span className="absolute inset-0 animate-ping rounded-full bg-mint opacity-60 motion-reduce:animate-none" />}
        <span className={clsx("relative size-2 rounded-full", status === "live" ? "bg-mint" : status === "connecting" ? "bg-warn" : "bg-faint")} />
      </span>
      {label}
    </span>
  );
}
