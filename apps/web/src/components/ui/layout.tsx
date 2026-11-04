import clsx from "clsx";
import * as React from "react";
import type { ReactNode } from "react";

const gaps = {
  xs: "gap-1",
  sm: "gap-2",
  md: "gap-4",
  lg: "gap-6",
  xl: "gap-8",
} as const;

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx("min-w-0", className)}>{children}</div>;
}

export function Section({
  title,
  description,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx("mb-[var(--space-section)] min-w-0", className)}>
      {title && (
        <header className="mb-5">
          <h2 className="text-2xl font-bold tracking-tight text-fg">{title}</h2>
          {description && <p className="mt-2 max-w-prose text-sm text-muted">{description}</p>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Grid({
  columns = 2,
  gap = "md",
  className,
  children,
}: {
  columns?: 1 | 2 | 3 | 4;
  gap?: keyof typeof gaps;
  className?: string;
  children: ReactNode;
}) {
  const cols = { 1: "grid-cols-1", 2: "grid-cols-1 sm:grid-cols-2", 3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3", 4: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4" } as const;
  return <div className={clsx("grid min-w-0", cols[columns], gaps[gap], className)}>{children}</div>;
}

export function Stack({
  gap = "md",
  as: Element = "div",
  className,
  children,
}: {
  gap?: keyof typeof gaps;
  as?: "div" | "ul" | "ol";
  className?: string;
  children: ReactNode;
}) {
  return <Element className={clsx("flex min-w-0 flex-col", gaps[gap], className)}>{children}</Element>;
}

export function Cluster({
  gap = "sm",
  className,
  children,
}: {
  gap?: keyof typeof gaps;
  className?: string;
  children: ReactNode;
}) {
  return <div className={clsx("flex min-w-0 flex-wrap items-center", gaps[gap], className)}>{children}</div>;
}
