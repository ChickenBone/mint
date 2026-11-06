"use client";

import * as React from "react";
import type { ReactNode } from "react";
import { Dialog } from "./interactive";
import { Button } from "./primitives";

export function ConfirmDialog({
  open,
  onOpenChange,
  onClose,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "danger",
  loading = false,
  busy = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  onClose?: () => void;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "primary" | "danger";
  loading?: boolean;
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  const isBusy = loading || busy;
  const handleOpenChange = (next: boolean) => {
    onOpenChange?.(next);
    if (!next) onClose?.();
  };
  return (
    <Dialog open={open} onOpenChange={handleOpenChange} title={title}>
      <div className="max-w-prose text-sm leading-relaxed text-muted">{description}</div>
      <div className="mt-6 flex flex-wrap justify-end gap-3">
        <Button type="button" variant="secondary" disabled={isBusy} onClick={() => handleOpenChange(false)}>
          {cancelLabel}
        </Button>
        <Button
          type="button"
          variant={tone === "danger" ? "danger" : "primary"}
          loading={isBusy}
          onClick={() => {
            void onConfirm();
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
