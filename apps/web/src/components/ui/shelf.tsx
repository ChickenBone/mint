"use client";

import clsx from "clsx";
import * as React from "react";
import { useRef, type KeyboardEvent, type ReactNode } from "react";

export function Shelf({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const railRef = useRef<HTMLUListElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const rail = railRef.current;
    if (!rail) return;
    const distance = Math.max(220, rail.clientWidth * 0.75);
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      rail.scrollBy({ left: (event.key === "ArrowRight" ? 1 : -1) * distance });
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      rail.scrollTo({ left: event.key === "Home" ? 0 : rail.scrollWidth });
    }
  };
  return (
    <ul
      ref={railRef}
      role="region"
      aria-label={label}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={clsx(
        "flex snap-x snap-proximity gap-4 overflow-x-auto overscroll-x-contain px-1 pb-3 scrollbar-thin focus-visible:outline-action",
        "[&>*]:w-[min(44vw,12rem)] [&>*]:shrink-0 [&>*]:snap-start sm:[&>*]:w-[min(30vw,12rem)]",
        className,
      )}
    >
      {children}
    </ul>
  );
}
