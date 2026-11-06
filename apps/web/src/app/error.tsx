"use client";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto flex min-h-[60dvh] max-w-md flex-col justify-center px-5">
      <div className="inline-flex items-center gap-2 text-xs font-semibold tracking-wider text-warn uppercase">
        <AlertTriangle className="size-4" aria-hidden />
        <span>Connection interrupted</span>
      </div>
      <h1 className="mt-2 text-3xl font-extrabold tracking-tight">Something skipped</h1>
      <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted">
        Mint couldn&rsquo;t load this page. The database or Redis may be restarting, or your connection dropped. Try again in a few seconds.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={reset}
          className="inline-flex min-h-11 items-center rounded-full bg-fg px-6 font-bold text-bg hover:scale-[1.03]"
        >
          Try again
        </button>
        <Link
          href="/app/collection?tab=downloads"
          className="inline-flex min-h-11 items-center rounded-full border border-line px-5 text-sm font-semibold text-fg hover:bg-hover"
        >
          Offline downloads
        </Link>
      </div>
    </main>
  );
}
