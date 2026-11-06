"use client";

import clsx from "clsx";
import { Loader2 } from "lucide-react";
import { useState, useTransition } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/** Small button that runs a server action, supports confirmation dialogs, and reports failure inline. */
export function ActionButton({
  action,
  children,
  tone = "neutral",
  confirm,
  confirmTitle = "Confirm action",
}: {
  action: () => Promise<unknown>;
  children: React.ReactNode;
  tone?: "primary" | "neutral" | "danger";
  confirm?: string;
  confirmTitle?: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const runAction = () => {
    start(async () => {
      try {
        setError(null);
        await action();
      } catch (e) {
        setError((e as Error).message || "That didn't work. Try again.");
      }
    });
  };

  return (
    <span className="inline-flex flex-col items-end">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (confirm) {
            setConfirmOpen(true);
            return;
          }
          runAction();
        }}
        className={clsx(
          "inline-flex min-h-11 items-center gap-1.5 rounded-full px-4 text-sm font-semibold transition disabled:cursor-wait disabled:opacity-60",
          tone === "primary" && "bg-mint text-mint-ink hover:bg-mint-strong",
          tone === "neutral" && "text-fg ring-1 ring-line hover:bg-elevated hover:ring-faint",
          tone === "danger" && "text-danger ring-1 ring-danger/40 hover:bg-danger/10",
        )}
      >
        {pending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
        {children}
      </button>
      {confirm && (
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={confirmTitle}
          description={confirm}
          confirmLabel={typeof children === "string" ? children : "Confirm"}
          tone={tone === "danger" ? "danger" : "primary"}
          loading={pending}
          onConfirm={() => {
            setConfirmOpen(false);
            runAction();
          }}
        />
      )}
      {error && (
        <span className="mt-1 text-xs text-danger" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
