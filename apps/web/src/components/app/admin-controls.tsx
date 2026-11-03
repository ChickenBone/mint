"use client";

import clsx from "clsx";
import { Loader2 } from "lucide-react";
import { useState, useTransition } from "react";

/** Small button that runs a server action and reports failure inline. */
export function ActionButton({
  action,
  children,
  tone = "neutral",
  confirm,
}: {
  action: () => Promise<unknown>;
  children: React.ReactNode;
  tone?: "primary" | "neutral" | "danger";
  confirm?: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-end">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          start(async () => {
            try {
              setError(null);
              await action();
            } catch (e) {
              setError((e as Error).message || "That didn't work. Try again.");
            }
          });
        }}
        className={clsx(
          "inline-flex h-8 items-center gap-1.5 rounded-full px-4 text-sm font-semibold transition disabled:cursor-wait disabled:opacity-60",
          tone === "primary" && "bg-mint text-mint-ink hover:bg-mint-strong",
          tone === "neutral" && "text-fg ring-1 ring-line hover:bg-elevated hover:ring-faint",
          tone === "danger" && "text-danger ring-1 ring-danger/40 hover:bg-danger/10",
        )}
      >
        {pending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
        {children}
      </button>
      {error && <span className="mt-1 text-xs text-danger" role="alert">{error}</span>}
    </span>
  );
}
