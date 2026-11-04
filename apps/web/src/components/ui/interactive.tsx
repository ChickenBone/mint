"use client";

import clsx from "clsx";
import * as React from "react";
import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";

type KeyNavigable = { disabled?: boolean };

export function getTabTargetIndex(tabs: readonly KeyNavigable[], currentIndex: number, key: string) {
  const length = tabs.length;
  if (!length) return undefined;
  let start: number;
  let direction = 1;
  if (key === "Home") start = 0;
  else if (key === "End") {
    start = length - 1;
    direction = -1;
  } else if (key === "ArrowRight" || key === "ArrowDown") start = (currentIndex + 1) % length;
  else if (key === "ArrowLeft" || key === "ArrowUp") {
    start = (currentIndex - 1 + length) % length;
    direction = -1;
  } else return undefined;

  for (let offset = 0; offset < length; offset += 1) {
    const index = (start + direction * offset + length * 2) % length;
    if (!tabs[index]?.disabled) return index;
  }
  return undefined;
}

export function getMenuTargetIndex(items: readonly KeyNavigable[], currentIndex: number, key: string) {
  const length = items.length;
  if (!length) return undefined;
  let start: number;
  let direction = 1;
  if (key === "Home") start = 0;
  else if (key === "End") {
    start = length - 1;
    direction = -1;
  } else if (key === "ArrowDown") start = currentIndex < 0 ? 0 : (currentIndex + 1) % length;
  else if (key === "ArrowUp") {
    start = currentIndex < 0 ? length - 1 : (currentIndex - 1 + length) % length;
    direction = -1;
  } else return undefined;

  for (let offset = 0; offset < length; offset += 1) {
    const index = (start + direction * offset + length * 2) % length;
    if (!items[index]?.disabled) return index;
  }
  return undefined;
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled = false,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={clsx(
        "relative inline-flex min-h-11 min-w-11 items-center rounded-full p-1 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action disabled:opacity-50",
        checked ? "bg-action" : "bg-hover",
        className,
      )}
    >
      <span className={clsx("size-5 rounded-full bg-background transition-transform duration-standard", checked && "translate-x-5")} />
    </button>
  );
}

export function Tabs({
  tabs,
  value,
  onValueChange,
  label,
  className,
}: {
  tabs: Array<{ value: string; label: string; content: ReactNode; disabled?: boolean }>;
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  className?: string;
}) {
  const id = useId();
  const currentIndex = Math.max(0, tabs.findIndex((tab) => tab.value === value));
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const nextIndex = getTabTargetIndex(tabs, currentIndex, event.key);
    if (nextIndex === undefined) return;
    event.preventDefault();
    refs.current[nextIndex]?.focus();
    onValueChange(tabs[nextIndex]!.value);
  };

  const selected = tabs.find((tab) => tab.value === value) ?? tabs[0];
  if (!selected) return null;

  return (
    <div className={className}>
      <div role="tablist" aria-label={label} onKeyDown={handleKeyDown} className="flex min-h-11 gap-1 border-b border-line">
        {tabs.map((tab, index) => {
          const selectedTab = tab.value === selected.value;
          return (
            <button
              key={tab.value}
              ref={(node) => { refs.current[index] = node; }}
              type="button"
              role="tab"
              id={`${id}-tab-${index}`}
              aria-selected={selectedTab}
              aria-controls={`${id}-panel-${index}`}
              tabIndex={selectedTab ? 0 : -1}
              disabled={tab.disabled}
              onClick={() => onValueChange(tab.value)}
              className={clsx(
                "min-h-11 rounded-t-control px-4 text-sm font-semibold text-muted hover:text-fg focus-visible:outline-action",
                selectedTab && "border-b-2 border-action text-fg",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab, index) => (
        <div
          key={tab.value}
          id={`${id}-panel-${index}`}
          role="tabpanel"
          aria-labelledby={`${id}-tab-${index}`}
          tabIndex={0}
          hidden={tab.value !== selected.value}
          className="focus-visible:outline-action"
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}

export function Dialog({
  open,
  onOpenChange,
  title,
  children,
  variant = "dialog",
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  variant?: "dialog" | "sheet";
  className?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={() => onOpenChange(false)}
      onClick={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
      className={clsx(
        "ui-dialog fixed inset-0 m-auto max-h-[min(90dvh,48rem)] w-[min(calc(100%-2.5rem),36rem)] overflow-y-auto rounded-surface border border-line bg-elevated p-6 text-fg shadow-floating backdrop:bg-background/75",
        variant === "sheet" && "ui-sheet",
        className,
      )}
    >
      <header className="mb-5 flex items-start justify-between gap-4">
        <h2 id={titleId} className="text-xl font-semibold">{title}</h2>
        <button
          type="button"
          aria-label="Close dialog"
          onClick={() => onOpenChange(false)}
          className="inline-grid size-11 shrink-0 place-items-center rounded-control text-muted hover:bg-hover hover:text-fg"
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>
      {children}
    </dialog>
  );
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

export function Menu({
  label,
  items,
  className,
}: {
  label: string;
  items: MenuItem[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useLayoutEffect(() => {
    if (open) itemRefs.current.find((item) => item && !item.disabled)?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [open]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = itemRefs.current.findIndex((item) => item === document.activeElement);
    const next = getMenuTargetIndex(items, index, event.key);
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (event.key === "Tab") {
      setOpen(false);
    } else if (next !== undefined) {
      event.preventDefault();
      itemRefs.current[next]?.focus();
    }
  };

  return (
    <div ref={rootRef} className={clsx("relative inline-block", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="inline-flex min-h-11 items-center rounded-control px-3 text-sm font-semibold text-muted hover:bg-hover hover:text-fg"
      >
        {label}
      </button>
      {open && (
        <div role="menu" aria-label={label} onKeyDown={onMenuKeyDown} className="absolute right-0 z-[var(--z-overlay)] mt-2 min-w-48 rounded-surface bg-elevated p-1 shadow-raised">
          {items.map((item, index) => (
            <button
              key={`${item.label}-${index}`}
              ref={(node) => { itemRefs.current[index] = node; }}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                item.onSelect();
                setOpen(false);
                triggerRef.current?.focus();
              }}
              className="flex min-h-11 w-full items-center rounded-control px-3 text-left text-sm text-fg hover:bg-hover focus-visible:outline-action disabled:opacity-50"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Popover({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  return (
    <details
      ref={detailsRef}
      className={clsx("relative", className)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && detailsRef.current?.open) {
          detailsRef.current.open = false;
          summaryRef.current?.focus();
        }
      }}
    >
      <summary
        ref={summaryRef}
        className="flex min-h-11 cursor-pointer list-none items-center rounded-control px-3 text-sm font-semibold text-muted hover:bg-hover hover:text-fg"
      >
        {label}
      </summary>
      <div role="group" aria-label={label} className="absolute right-0 z-[var(--z-overlay)] mt-2 min-w-56 rounded-surface bg-elevated p-4 shadow-raised">
        {children}
      </div>
    </details>
  );
}

export function Tooltip({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactElement<{ "aria-describedby"?: string }>;
  className?: string;
}) {
  const id = useId();
  const child = Children.only(children);
  const existing = isValidElement(child) ? child.props["aria-describedby"] : undefined;
  return (
    <span className={clsx("group relative inline-flex", className)}>
      {cloneElement(child, { "aria-describedby": [existing, id].filter(Boolean).join(" ") })}
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-[var(--z-overlay)] mb-2 w-max max-w-56 -translate-x-1/2 rounded-control bg-hover px-3 py-2 text-xs text-fg opacity-0 shadow-raised transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {label}
      </span>
    </span>
  );
}
