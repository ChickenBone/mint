import clsx from "clsx";
import NextLink from "next/link";
import * as React from "react";
import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";
import { useId } from "react";

const buttonVariants = {
  primary: "ui-primary bg-action text-action-ink hover:bg-action-strong",
  secondary: "bg-elevated text-fg hover:bg-hover",
  quiet: "bg-transparent text-muted hover:bg-surface hover:text-fg",
  danger: "bg-danger/15 text-danger hover:bg-danger/25",
} as const;

const buttonSizes = {
  sm: "min-h-11 px-3 text-sm",
  md: "min-h-11 px-4 text-sm",
  lg: "min-h-12 px-6 text-base",
} as const;

export type ButtonVariant = keyof typeof buttonVariants;
export type ButtonSize = keyof typeof buttonSizes;

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  className,
  disabled,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(
        "ui-control inline-flex items-center justify-center gap-2 rounded-control font-semibold transition-colors duration-standard disabled:cursor-not-allowed disabled:opacity-55",
        buttonVariants[variant],
        buttonSizes[size],
        className,
      )}
    >
      {children}
    </button>
  );
}

export function IconButton({
  variant = "quiet",
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  "aria-label": string;
}) {
  return (
    <Button
      {...props}
      variant={variant}
      className={clsx("size-11 shrink-0 p-0", className)}
    >
      {children}
    </Button>
  );
}

export function Link({
  variant = "quiet",
  className,
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  variant?: ButtonVariant;
  href: string;
}) {
  return (
    <NextLink
      {...props}
      className={clsx(
        "ui-control inline-flex min-h-11 items-center justify-center gap-2 rounded-control px-3 font-semibold transition-colors duration-standard",
        buttonVariants[variant],
        className,
      )}
    >
      {children}
    </NextLink>
  );
}

export function Input({
  label,
  name,
  hint,
  error,
  className,
  id,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: ReactNode;
  name: string;
  hint?: ReactNode;
  error?: ReactNode;
}) {
  const generatedId = useId();
  const inputId = id ?? `input-${name}-${generatedId}`;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const describedBy = [props["aria-describedby"], error ? errorId : hint ? hintId : undefined]
    .filter(Boolean)
    .join(" ") || undefined;

  return (
    <div className={className}>
      <label htmlFor={inputId} className="mb-1.5 block text-sm font-semibold text-fg">
        {label}
      </label>
      <input
        {...props}
        id={inputId}
        name={name}
        aria-invalid={error ? true : props["aria-invalid"]}
        aria-describedby={describedBy}
        className={clsx(
          "ui-field min-h-11 w-full rounded-control bg-elevated px-4 text-fg placeholder:text-faint ring-1 transition-colors duration-standard focus-visible:ring-2 focus-visible:ring-action",
          error ? "ring-danger" : "ring-line hover:ring-faint",
        )}
      />
      {error ? (
        <p id={errorId} className="mt-1.5 text-sm text-danger">{error}</p>
      ) : hint ? (
        <p id={hintId} className="mt-1.5 text-sm text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function Select({
  label,
  name,
  className,
  id,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: ReactNode;
  name: string;
}) {
  const generatedId = useId();
  const selectId = id ?? `select-${name}-${generatedId}`;
  return (
    <div className={className}>
      <label htmlFor={selectId} className="mb-1.5 block text-sm font-semibold text-fg">
        {label}
      </label>
      <select
        {...props}
        id={selectId}
        name={name}
        className={clsx(
          "ui-field min-h-11 w-full rounded-control bg-elevated px-4 text-fg ring-1 ring-line focus-visible:ring-2 focus-visible:ring-action",
        )}
      >
        {children}
      </select>
    </div>
  );
}

export function Checkbox({
  label,
  name,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: ReactNode;
  name: string;
}) {
  return (
    <label className={clsx("inline-flex min-h-11 cursor-pointer items-center gap-3 text-sm text-fg", className)}>
      <input
        {...props}
        type="checkbox"
        name={name}
        className="size-5 accent-action focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action"
      />
      <span>{label}</span>
    </label>
  );
}

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: "neutral" | "positive" | "warning" | "danger";
  className?: string;
  children: ReactNode;
}) {
  const tones = {
    neutral: "bg-elevated text-muted",
    positive: "bg-success/15 text-success",
    warning: "bg-warn/15 text-warn",
    danger: "bg-danger/15 text-danger",
  } as const;
  return (
    <span className={clsx("inline-flex min-h-6 items-center rounded-full px-2.5 text-xs font-semibold", tones[tone], className)}>
      {children}
    </span>
  );
}

export function Card({
  as: Element = "div",
  className,
  children,
}: {
  as?: "div" | "article" | "section";
  className?: string;
  children: ReactNode;
}) {
  return (
    <Element className={clsx("ui-card rounded-surface bg-surface", className)}>
      {children}
    </Element>
  );
}

export function Sleeve({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={clsx("aspect-square overflow-hidden bg-elevated", className)}>
      {children}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={clsx("block animate-pulse rounded-control bg-elevated motion-reduce:animate-none", className)}
    />
  );
}

export function EmptyState({
  title,
  children,
  action,
  className,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx("py-10 text-center", className)} aria-label={title}>
      <h2 className="text-xl font-semibold text-fg">{title}</h2>
      {children && <div className="mx-auto mt-2 max-w-prose text-sm text-muted">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </section>
  );
}

export function ErrorState({
  title,
  children,
  action,
  className,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx("rounded-surface bg-surface p-5", className)} role="alert">
      <h2 className="text-lg font-semibold text-fg">{title}</h2>
      {children && <div className="mt-2 text-sm text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </section>
  );
}

export function ProgressBar({
  value,
  max = 100,
  label,
  className,
}: {
  value: number;
  max?: number;
  label: string;
  className?: string;
}) {
  const effectiveMax = Number.isFinite(max) ? Math.max(0, max) : 0;
  const normalized = effectiveMax > 0 && Number.isFinite(value) ? Math.min(effectiveMax, Math.max(0, value)) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={effectiveMax}
      aria-valuenow={normalized}
      className={clsx("h-2 overflow-hidden rounded-full bg-elevated", className)}
    >
      <div className="h-full rounded-full bg-muted transition-[width] duration-standard" style={{ width: `${effectiveMax > 0 ? (normalized / effectiveMax) * 100 : 0}%` }} />
    </div>
  );
}

export function Slider({
  label,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
}) {
  const generatedId = useId();
  const id = props.id ?? `slider-${props.name ?? "value"}-${generatedId}`;
  return (
    <label htmlFor={id} className={clsx("block text-sm text-fg", className)}>
      <span className="mb-2 block">{label}</span>
      <input
        {...props}
        id={id}
        type="range"
        aria-label={props["aria-label"] ?? label}
        className="min-h-11 w-full accent-action focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action"
      />
    </label>
  );
}

export { Artwork } from "../artwork";

export function Row({
  rank,
  status,
  className,
  children,
}: {
  rank?: number;
  status?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={clsx("grid min-h-16 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-line/60 py-2", className)}>
      {rank !== undefined && <span className="sr-only">Rank {rank}.</span>}
      <div className="min-w-0">{children}</div>
      {status && <span className="text-sm text-muted">{status}</span>}
    </div>
  );
}
