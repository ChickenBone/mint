"use client";

import clsx from "clsx";
import { CheckCircle2, Flag } from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Dialog } from "@/components/ui/interactive";
import { Button } from "@/components/ui/primitives";
import {
  ISSUE_CATEGORIES,
  ISSUE_CONTEXT_MAX,
  ISSUE_MESSAGE_MAX,
  type IssueCategory,
} from "@/lib/issue-report-model";

export interface ReportIssueOptions {
  /**
   * Optional human-readable context such as "Song title — Artist". It is shown to the
   * member, sent only if they leave it ticked, and must never contain internal identifiers.
   */
  context?: string | null;
  defaultCategory?: IssueCategory;
}

/** Controlled dialog for callers that open it from their own menu item or button. */
export function ReportIssueDialog({
  open,
  onOpenChange,
  context = null,
  defaultCategory = "app",
}: ReportIssueOptions & { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Report an issue">
      {open && (
        <ReportIssueForm
          context={context?.trim().slice(0, ISSUE_CONTEXT_MAX) || null}
          defaultCategory={defaultCategory}
          onDone={() => onOpenChange(false)}
        />
      )}
    </Dialog>
  );
}

/** Self-contained "Report an issue" button and dialog. */
export function ReportIssueButton({
  context,
  defaultCategory,
  className,
  children = "Report an issue",
  icon = true,
}: ReportIssueOptions & {
  /** Replaces the default trigger styling (layout, 44px height and gap are kept). */
  className?: string;
  children?: ReactNode;
  icon?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className={clsx(
          "inline-flex min-h-11 items-center gap-2 text-sm transition-colors",
          className ?? "rounded-control px-4 font-semibold text-muted hover:bg-hover hover:text-fg",
        )}
      >
        {icon && <Flag className="size-4 shrink-0" aria-hidden />}
        {children}
      </button>
      <ReportIssueDialog open={open} onOpenChange={setOpen} context={context} defaultCategory={defaultCategory} />
    </>
  );
}

function ReportIssueForm({
  context,
  defaultCategory,
  onDone,
}: {
  context: string | null;
  defaultCategory: IssueCategory;
  onDone: () => void;
}) {
  const ids = useId();
  const [category, setCategory] = useState<IssueCategory>(defaultCategory);
  const [message, setMessage] = useState("");
  const [includeContext, setIncludeContext] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const messageId = `${ids}-message`;
  const hintId = `${ids}-hint`;
  const errorId = `${ids}-error`;
  const remaining = ISSUE_MESSAGE_MAX - message.length;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (!message.trim()) {
      setError("Tell us what went wrong.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/issue-reports", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ category, message, context: includeContext ? context : null }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || "Your report couldn't be sent. Try again in a moment.");
      }
      setSent(true);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Your report couldn't be sent. Try again in a moment.");
    } finally {
      setPending(false);
    }
  }

  if (sent) {
    return (
      <div className="space-y-5" role="status">
        <p className="flex items-start gap-3 text-sm leading-relaxed text-fg">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
          Thanks. Your report was sent to the people who run this server.
        </p>
        <div className="flex justify-end">
          <Button type="button" onClick={onDone} autoFocus>Done</Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      {context && (
        <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-control bg-surface px-4 py-3 text-sm text-muted has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-action">
          <input
            type="checkbox"
            checked={includeContext}
            onChange={(event) => setIncludeContext(event.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-[var(--color-action)]"
          />
          <span className="min-w-0">
            Include <span className="font-semibold break-words text-fg">{context}</span>
          </span>
        </label>
      )}

      <fieldset>
        <legend className="mb-2 text-sm font-semibold text-fg">What&apos;s the problem?</legend>
        <div className="space-y-1">
          {ISSUE_CATEGORIES.map((option) => (
            <label
              key={option.value}
              className={clsx(
                "flex min-h-11 cursor-pointer items-center gap-3 rounded-control px-3 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-action",
                category === option.value ? "bg-hover text-fg" : "text-muted hover:bg-surface hover:text-fg",
              )}
            >
              <input
                type="radio"
                name={`${ids}-category`}
                value={option.value}
                checked={category === option.value}
                onChange={() => setCategory(option.value)}
                className="size-4 accent-[var(--color-action)]"
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <label htmlFor={messageId} className="mb-1.5 block text-sm font-semibold text-fg">
          Tell us what happened
        </label>
        <textarea
          id={messageId}
          value={message}
          onChange={(event) => setMessage(event.target.value.slice(0, ISSUE_MESSAGE_MAX))}
          maxLength={ISSUE_MESSAGE_MAX}
          rows={5}
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${hintId} ${errorId}` : hintId}
          className={clsx(
            "w-full resize-y rounded-control bg-surface px-4 py-3 text-fg ring-1 transition-colors placeholder:text-faint focus-visible:ring-2 focus-visible:ring-action",
            error ? "ring-danger" : "ring-line hover:ring-faint",
          )}
        />
        <p id={hintId} className="mt-1.5 text-xs text-muted">
          Only what you see here is sent. {remaining < 200 && <span className="tabular">{remaining} characters left.</span>}
        </p>
        {error && (
          <p id={errorId} role="alert" className="mt-1.5 text-sm text-danger">{error}</p>
        )}
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="quiet" onClick={onDone}>Cancel</Button>
        <Button type="submit" loading={pending}>{pending ? "Sending…" : "Send report"}</Button>
      </div>
    </form>
  );
}
