"use client";

import clsx from "clsx";
import { Loader2 } from "lucide-react";
import { useFormStatus } from "react-dom";

export function Field({
  label,
  name,
  error,
  hint,
  className,
  ...input
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; name: string; error?: string; hint?: string }) {
  const id = `f-${name}`;
  const described = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-sm font-semibold">
        {label}
      </label>
      <input
        id={id}
        name={name}
        aria-invalid={!!error || undefined}
        aria-describedby={described}
        className={clsx(
          "h-12 w-full rounded-lg bg-elevated px-4 text-fg placeholder:text-faint outline-none ring-1 transition focus:ring-2 focus:ring-mint",
          error ? "ring-danger" : "ring-line hover:ring-faint",
        )}
        {...input}
      />
      {error ? (
        <p id={`${id}-err`} className="mt-1.5 text-sm text-danger">{error}</p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-sm text-faint">{hint}</p>
      ) : null}
    </div>
  );
}

export function SubmitButton({ children, pendingLabel, className }: { children: React.ReactNode; pendingLabel: string; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={clsx(
        "inline-flex h-12 items-center justify-center gap-2 rounded-full bg-mint px-8 font-bold text-mint-ink transition hover:scale-[1.02] hover:bg-mint-strong disabled:cursor-wait disabled:opacity-70 disabled:hover:scale-100",
        className,
      )}
    >
      {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {pending ? pendingLabel : children}
    </button>
  );
}
