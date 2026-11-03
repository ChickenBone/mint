"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { Download } from "lucide-react";

interface InstallPrompt extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> }
const InstallContext = createContext<{
  prompt: InstallPrompt | null; installed: boolean; error: string | null; install: () => Promise<void>;
} | null>(null);

export function InstallProvider({ children }: { children: React.ReactNode }) {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [installed, setInstalled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const installable = (event: Event) => { event.preventDefault(); setPrompt(event as InstallPrompt); };
    const installed = () => { setInstalled(true); setPrompt(null); };
    window.addEventListener("beforeinstallprompt", installable);
    window.addEventListener("appinstalled", installed);
    if ("serviceWorker" in navigator && window.isSecureContext) {
      void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error: unknown) => {
        console.error("Mint app registration failed", error);
        setError("Installation setup failed. Reload Mint while connected and try again.");
      });
    }
    const query = matchMedia("(display-mode: standalone)");
    const changed = () => setInstalled(query.matches);
    queueMicrotask(changed);
    query.addEventListener("change", changed);
    return () => { window.removeEventListener("beforeinstallprompt", installable); window.removeEventListener("appinstalled", installed); query.removeEventListener("change", changed); };
  }, []);
  const install = async () => {
    if (!prompt) return;
    try { await prompt.prompt(); const result = await prompt.userChoice; setPrompt(null); if (result.outcome === "accepted") setInstalled(true); }
    catch (error) { console.error("Mint installation failed", error); setError("Chrome could not open installation. Use its menu and choose Install app."); }
  };
  return <InstallContext.Provider value={{ prompt, installed, error, install }}>{children}</InstallContext.Provider>;
}

export function InstallApp({ compact = false }: { compact?: boolean }) {
  const context = useContext(InstallContext);
  if (!context || context.installed || (compact && !context.prompt)) return null;
  const { prompt, error, install } = context;
  return <div className="text-sm">
    {prompt ? <button aria-label="Install Mint" className={`inline-flex min-h-11 items-center gap-2 rounded-full bg-mint px-3 py-2 text-sm font-semibold text-mint-ink hover:bg-mint-strong ${compact ? "max-sm:hidden" : ""}`}
      onClick={install}><Download className="size-4" />{compact ? "Install" : "Install Mint"}</button>
      : <p className="text-muted">On Android Chrome, open the browser menu and choose <strong className="text-fg">Install app</strong> or <strong className="text-fg">Add to Home screen</strong>.</p>}
    {error && <p role="alert" className="mt-2 text-danger">{error}</p>}
  </div>;
}
