"use client";

import clsx from "clsx";
import * as React from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

type ToastTone = "neutral" | "success" | "error";
type ToastAction = { label: string; onAction: () => void | Promise<void> };
type ToastRecord = { id: number; message: string; tone: ToastTone; action?: ToastAction };
type ToastContextValue = { showToast: (message: string, tone?: ToastTone, action?: ToastAction) => void };

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback((message: string, tone: ToastTone = "neutral", action?: ToastAction) => {
    const id = ++nextId.current;
    setToasts((current) => [...current, { id, message, tone, action }].slice(-5));
    timers.current.set(id, setTimeout(() => dismiss(id), 5000));
  }, [dismiss]);

  const runAction = async (toast: ToastRecord) => {
    if (!toast.action) return;
    try {
      await toast.action.onAction();
      dismiss(toast.id);
    } catch (error) {
      console.error("Notification action failed", error);
      showToast(error instanceof Error ? error.message : "That action could not be completed. Try again.", "error");
    }
  };

  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div aria-label="Notifications" className="fixed right-4 top-4 z-[var(--z-toast)] flex w-[min(calc(100vw-2rem),24rem)] flex-col gap-2 sm:right-6 sm:top-6">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.tone === "error" ? "alert" : "status"}
            className={clsx(
              "flex min-h-12 items-center justify-between gap-3 rounded-surface bg-elevated px-4 py-3 text-sm text-fg shadow-raised",
              toast.tone === "success" && "ring-1 ring-success/50",
              toast.tone === "error" && "ring-1 ring-danger/60",
            )}
          >
            <span>{toast.message}</span>
            <div className="flex shrink-0 items-center gap-1">
              {toast.action && <button type="button" onClick={() => void runAction(toast)} className="min-h-11 rounded-control px-3 font-semibold text-action hover:bg-hover">{toast.action.label}</button>}
              <button type="button" aria-label="Dismiss notification" onClick={() => dismiss(toast.id)} className="grid size-11 place-items-center rounded-control text-muted hover:bg-hover hover:text-fg">×</button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used within ToastProvider");
  return context;
}
