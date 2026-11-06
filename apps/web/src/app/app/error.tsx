"use client";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";

export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="mx-auto flex min-h-[50dvh] max-w-md flex-col justify-center py-12">
      <div className="inline-flex items-center gap-2 text-xs font-semibold tracking-wider text-warn uppercase">
        <AlertTriangle className="size-4" aria-hidden />
        <span>Page unavailable</span>
      </div>
      <h1 className="mt-2 text-3xl font-extrabold tracking-tight">Something skipped</h1>
      <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted">
        This view couldn&rsquo;t load right now. Active playback continues in the player below; retry loading or open your offline downloads.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={reset}
          className="inline-flex min-h-11 items-center rounded-full bg-mint px-5 text-sm font-bold text-mint-ink hover:bg-mint-strong"
        >
          Try again
        </button>
        <Link
          href="/app/collection?tab=downloads"
          className="inline-flex min-h-11 items-center rounded-full border border-line px-5 text-sm font-semibold text-fg hover:bg-hover"
        >
          Open Downloads
        </Link>
      </div>
    </div>
  );
}
