"use client";

import { useSyncExternalStore } from "react";

function subscribeOnline(listener: () => void) {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

function isOnline() {
  return navigator.onLine;
}

export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const online = useSyncExternalStore(subscribeOnline, isOnline, () => true);
  return <section role="alert" className="mx-auto max-w-xl py-16">
    <h1 className="text-2xl font-bold">This part of Mint couldn’t load.</h1>
    <p className="mt-3 text-sm leading-relaxed text-muted">{online ? "Your library and playback are unchanged. Try again in a moment." : "You appear to be offline. Reconnect and try again; downloaded music remains available."}</p>
    <button type="button" onClick={reset} className="mt-6 min-h-11 rounded-full bg-mint px-5 font-semibold text-mint-ink hover:bg-mint-strong">Try again</button>
  </section>;
}
