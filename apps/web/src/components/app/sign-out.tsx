"use client";

import { useState } from "react";
import { LogOut } from "lucide-react";
import { clearOffline } from "@/lib/offline";

export function SignOut() {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const signOut = async () => {
    setBusy(true); setError(null);
    try {
      if ("indexedDB" in window) await clearOffline();
      const response = await fetch("/api/player/offline/logout", { method: "POST", credentials: "same-origin" });
      if (!response.ok) throw new Error("Sign-out failed. Check the connection and try again.");
      const channel = "BroadcastChannel" in window ? new BroadcastChannel("mint-access") : null;
      channel?.postMessage({ type: "sign-out" }); channel?.close();
      // A full document load drops every in-memory player and account state after logout.
      window.location.replace(new URL("/", window.location.origin).href);
    } catch (error) { setError(error instanceof Error ? error.message : "Sign-out failed."); setBusy(false); }
  };
  return <div>
    <button disabled={busy} onClick={() => void signOut()} aria-label="Sign out" className="inline-flex items-center gap-1.5 rounded-full px-3 py-2.5 text-sm font-semibold text-muted transition hover:bg-elevated hover:text-fg disabled:opacity-40">
      <LogOut className="size-4" aria-hidden /><span className="hidden sm:inline">{busy ? "Signing out…" : "Sign out"}</span>
    </button>
    {error && <p role="alert" className="fixed right-4 top-16 z-50 max-w-sm rounded bg-elevated p-4 text-sm text-warn">{error}</p>}
  </div>;
}
