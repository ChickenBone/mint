"use client";

import { DEFAULT_MATCHING_CONTROLS, type MatchingView } from "@mint/core/matching";
import { useCallback, useEffect, useState } from "react";
import { Button, Input } from "@/components/ui/primitives";
import { Switch } from "@/components/ui/interactive";

const EMPTY_VIEW: MatchingView = { ...DEFAULT_MATCHING_CONTROLS, keyConfigured: false, keyHint: null };

export function MatchingPanel() {
  const [controls, setControls] = useState<MatchingView>(EMPTY_VIEW);
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/admin/matching", { cache: "no-store", signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Matching settings could not load.");
      setControls(body.controls);
      setError("");
    } catch (reason) {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "Matching settings could not load.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => void load(controller.signal));
    return () => controller.abort();
  }, [load]);

  async function save(next: { enabled: boolean; apiKey?: string; clearKey?: boolean }) {
    const previous = controls;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/admin/matching", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Matching setting could not be saved.");
      setControls(body.controls);
      setApiKey("");
      setNotice(body.controls.enabled
        ? "OpenAI song matching enabled. Unavailable or uncertain decisions still use deterministic matching."
        : next.clearKey
          ? "OpenAI API key removed. Mint will use deterministic matching only."
          : "OpenAI song matching disabled. Mint will use deterministic matching only.");
    } catch (reason) {
      setControls(previous);
      setError(reason instanceof Error ? reason.message : "Matching setting could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  const keyReady = controls.keyConfigured || apiKey.trim().length > 0;

  return <div className="max-w-3xl space-y-8">
    {error && <p role="alert" className="text-danger">{error} <button type="button" className="underline" onClick={() => void load()}>Try again</button></p>}
    <p role="status" aria-live="polite" className="text-sm text-mint">{notice}</p>
    <form className="space-y-6 rounded-xl border border-line bg-elevated p-5" onSubmit={(event) => {
      event.preventDefault();
      void save({ enabled: controls.enabled, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
    }}>
      <section aria-labelledby="matching-model">
        <div className="flex items-center justify-between gap-6">
          <div>
            <h2 id="matching-model" className="text-lg font-bold">OpenAI song matching</h2>
            <p className="mt-1 text-sm text-muted">Ask OpenAI Decisions to choose the most likely original recording from YouTube search results.</p>
          </div>
          <Switch
            checked={controls.enabled}
            onCheckedChange={(enabled) => setControls({ ...controls, enabled })}
            label="Enable OpenAI song matching"
            disabled={loading || busy || (!keyReady && !controls.enabled)}
          />
        </div>
        <p className="mt-5 text-sm text-muted">
          {loading ? "Loading setting…" : controls.enabled ? "Enabled" : "Disabled"}.
          Manual YouTube URLs are never changed. If OpenAI is unavailable, times out, or is not confident, Mint falls back to its deterministic matcher.
        </p>
      </section>
      <Input
        label="OpenAI API key"
        name="openai-api-key"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={apiKey}
        placeholder={controls.keyHint ? `Saved key ending in ${controls.keyHint}` : "sk-…"}
        hint="Stored encrypted. Mint shows only the last four characters after saving."
        onChange={(event) => setApiKey(event.target.value)}
      />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" loading={busy} disabled={loading || busy}>Save matching</Button>
        {controls.keyConfigured && <Button type="button" variant="danger" disabled={loading || busy} onClick={() => void save({ enabled: false, clearKey: true })}>Remove key</Button>}
      </div>
    </form>
    <aside className="space-y-3 border-t border-line pt-5 text-sm text-muted">
      <h2 className="font-semibold text-fg">What is sent</h2>
      <p>Each decision sends the requested title, artist, and duration plus up to ten public candidate titles, channels, and durations. A full ten-candidate decision costs about $0.0005. Audio, account tokens, member data, and media files are never sent.</p>
    </aside>
  </div>;
}
