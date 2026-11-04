"use client";

import { useSyncExternalStore } from "react";
import { LinkYoutubeCallout } from "./link-youtube";

const dismissedKey = "mint:setup-nudge-dismissed";
const dismissedEvent = "mint:setup-nudge-dismissed-change";

function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(dismissedEvent, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(dismissedEvent, listener);
  };
}

function isVisible() {
  try { return localStorage.getItem(dismissedKey) !== "true"; }
  catch { return true; }
}

export function SetupNudge() {
  const visible = useSyncExternalStore(subscribe, isVisible, () => false);
  if (!visible) return null;
  return <aside className="relative my-8">
    <button type="button" onClick={() => {
      try { localStorage.setItem(dismissedKey, "true"); } catch {}
      window.dispatchEvent(new Event(dismissedEvent));
    }} className="absolute right-2 top-2 z-10 inline-flex min-h-11 items-center rounded-full px-3 text-sm text-muted hover:bg-hover hover:text-fg">Dismiss setup tip</button>
    <LinkYoutubeCallout />
  </aside>;
}
