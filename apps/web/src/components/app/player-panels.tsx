"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, Repeat, Shuffle, X } from "lucide-react";
import { defaultDsp, type DspSettings, type PlayerCommand, type PlayerState } from "@/lib/player-protocol";
import { lyricsSchema, parseLrc, type Lyrics } from "@/lib/lyrics";
import { InstallApp } from "../install-app";

export function PlayerPanel({ title, close, children }: { title: string; close: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [close]);
  return <aside aria-label={title} className="absolute inset-y-0 right-0 z-30 flex w-full flex-col border-l border-line bg-surface sm:w-[26rem]">
    <div className="flex items-center justify-between border-b border-line px-5 py-3"><h2 className="text-xl font-bold">{title}</h2>
      <button ref={ref} aria-label={`Close ${title.toLowerCase()}`} onClick={close} className="rounded-full p-2.5 hover:bg-hover"><X className="size-5" /></button></div>
    <div className="min-h-0 flex-1 overflow-y-auto p-5 scrollbar-thin">{children}</div>
  </aside>;
}

const presets: Record<string, number[]> = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  Warm: [3, 3, 2, 1, 0, 0, -1, -1, -2, -2],
  Vocal: [-2, -2, -1, 0, 2, 3, 3, 2, 0, -1],
  "Low listening": [4, 3, 1, 0, -1, 0, 1, 2, 3, 3],
};
const labels = ["31", "62", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"];
export function AudioPanel({ state, command }: { state: PlayerState; command: (command: PlayerCommand) => void }) {
  const settings = state.dsp ?? defaultDsp;
  const [draft, setDraft] = useState<DspSettings>(settings);
  const [dirty, setDirty] = useState(false);
  const current = dirty ? draft : settings;
  const update = (patch: Partial<DspSettings>) => { setDraft({ ...current, ...patch }); setDirty(true); };
  const control = "min-h-11 rounded-full bg-elevated px-4 py-2 text-sm font-semibold hover:bg-hover disabled:opacity-40";
  return <div className="space-y-7">
    <div>
      <h3 className="font-semibold">Playback</h3>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className={control} disabled={!state.track} aria-pressed={state.shuffle} onClick={() => command({ action: "shuffle" })}><Shuffle className="mr-2 inline size-4" />Shuffle {state.shuffle ? "on" : "off"}</button>
        <button className={control} disabled={!state.track} aria-pressed={state.repeat > 0} onClick={() => command({ action: "repeat" })}><Repeat className="mr-2 inline size-4" />Repeat {["off", "one", "all"][state.repeat]}</button>
        <button className={control} disabled={!state.track} onClick={() => command({ action: "toggle" })}>{state.playing ? <Pause className="mr-2 inline size-4" /> : <Play className="mr-2 inline size-4" />}{state.playing ? "Pause" : "Play"}</button>
      </div>
    </div>
    {!state.dspAvailable && <p role="status" className="text-sm text-warn">Web Audio is unavailable. Use current Chrome for processing and smooth transitions.</p>}
    <fieldset disabled={!state.dspAvailable} className="space-y-5 disabled:opacity-50">
      <legend className="mb-3 text-lg font-bold">Your sound</legend>
      <label className="flex min-h-11 items-center gap-3 text-sm font-semibold"><input type="checkbox" checked={current.enabled} onChange={(event) => update({ enabled: event.target.checked })} className="size-5 accent-mint" />10-band equalizer</label>
      <label className="flex flex-col gap-2 text-sm">Preset
        <select aria-label="EQ preset" value={Object.keys(presets).find((key) => JSON.stringify(presets[key]) === JSON.stringify(current.bands)) ?? "Custom"}
          onChange={(event) => update({ bands: presets[event.target.value]!, enabled: true })} className="min-h-11 rounded-md border border-line bg-elevated px-3">
          <option value="Custom" disabled>Custom</option>{Object.keys(presets).map((key) => <option key={key}>{key}</option>)}
        </select>
      </label>
      <div className="space-y-1">
        {labels.map((label, index) => <label key={label} className="flex min-h-10 items-center gap-3 text-xs tabular">
          <span className="w-12 shrink-0 whitespace-nowrap text-muted">{label} Hz</span><input aria-label={`EQ ${label} Hz`} type="range" min="-12" max="12" step=".5" value={current.bands[index]}
            onChange={(event) => update({ bands: current.bands.map((value, i) => i === index ? Number(event.target.value) : value) })} className="h-5 min-w-0 flex-1 accent-mint" />
          <span className="w-12 shrink-0 text-right">{current.bands[index]} dB</span>
        </label>)}
      </div>
      <label className="block text-sm">Preamp <span className="float-right text-muted tabular">{current.preamp} dB</span>
        <input aria-label="Preamp" type="range" min="-18" max="0" step=".5" value={current.preamp} onChange={(event) => update({ preamp: Number(event.target.value) })} className="mt-3 h-5 w-full accent-mint" />
      </label>
      <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={current.compressor} onChange={(event) => update({ compressor: event.target.checked })} className="size-5 accent-mint" />Dynamic range compression</label>
      <label className="block text-sm">Smooth transitions <span className="float-right text-muted tabular">{current.crossfade ? `${current.crossfade}s` : "Off"}</span>
        <input aria-label="Crossfade seconds" type="range" min="0" max="12" step="1" value={current.crossfade} onChange={(event) => update({ crossfade: Number(event.target.value) })} className="mt-3 h-5 w-full accent-mint" />
      </label>
      <p className="text-xs leading-relaxed text-muted">Real browser EQ, compression and overlapping equal-power crossfades. EQ boosts reserve headroom; enabling transitions reserves another 3.1 dB. Transitions are off by default for continuous albums; this is not Plexamp&apos;s proprietary Sweet Fades. Repeat-one does not crossfade.</p>
      <div className="flex flex-wrap gap-2">
        <button disabled={!dirty} className="min-h-11 rounded-full bg-mint px-5 py-2 text-sm font-bold text-mint-ink hover:bg-mint-strong disabled:opacity-40"
          onClick={() => { command({ action: "dsp", settings: current }); setDirty(false); }}>Apply sound</button>
        <button className={control} onClick={() => { command({ action: "dsp", settings: defaultDsp }); setDirty(false); }}>Reset / bypass</button>
      </div>
    </fieldset>
    <div><h3 className="mb-3 font-semibold">Listen on your phone</h3><InstallApp /><p className="mt-3 text-xs leading-relaxed text-muted">Audio settings stay on this device for your account. Installation needs HTTPS. Music still needs a server connection.</p></div>
  </div>;
}

export function LyricsPanel({ state, command }: { state: PlayerState; command: (command: PlayerCommand) => void }) {
  const id = state.track?.ratingKey;
  return id ? <TrackLyrics key={id} id={id} state={state} command={command} /> : <p className="text-sm text-muted">Choose a song to see its lyrics.</p>;
}
function TrackLyrics({ id, state, command }: { id: string; state: PlayerState; command: (command: PlayerCommand) => void }) {
  const [result, setResult] = useState<{ lyrics: Lyrics | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [retryRemaining, setRetryRemaining] = useState(0);
  const [follow, setFollow] = useState(true);
  const active = useRef<HTMLButtonElement>(null);
  const lines = useMemo(() => parseLrc(result?.lyrics?.syncedLyrics ?? ""), [result]);
  const index = lines.findLastIndex((line) => line.time <= state.time);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/player/lyrics/${id}`, { signal: controller.signal, cache: "no-store" }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) {
        setRetryRemaining(Number(response.headers.get("retry-after")) || 5);
        throw new Error(body.error ?? "Lyrics could not load.");
      }
      if (!controller.signal.aborted) setResult({ lyrics: body.lyrics === null ? null : lyricsSchema.parse(body.lyrics) });
    }).catch((error: unknown) => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Lyrics could not load."); });
    return () => controller.abort();
  }, [id, retry]);
  useEffect(() => {
    if (retryRemaining <= 0) return;
    const timer = setTimeout(() => setRetryRemaining((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => clearTimeout(timer);
  }, [retryRemaining]);
  useEffect(() => {
    if (follow && index >= 0) active.current?.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }, [index, follow]);
  return <div onWheel={() => setFollow(false)} onTouchMove={() => setFollow(false)}>
    <p className="font-semibold">{state.track?.title}</p><p className="mt-1 text-sm text-muted">{state.track?.artist}</p>
    <p className="mt-4 text-xs leading-relaxed text-muted">Lyrics from <a className="underline hover:text-fg" href="https://lrclib.net" target="_blank" rel="noreferrer">LRCLIB</a>. Looking up lyrics sends the song&apos;s title, artist, album and duration, never its audio.</p>
    {error ? <div role="alert" className="mt-6 text-sm"><p className="text-warn">{error}</p><button disabled={retryRemaining > 0} className="mt-3 min-h-11 rounded-full bg-elevated px-4 hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
      onClick={() => { setError(null); setResult(null); setRetry((n) => n + 1); }}>{retryRemaining > 0 ? `Retry in ${retryRemaining}s` : "Retry lyrics"}</button></div>
      : !result ? <p role="status" className="mt-6 text-sm text-muted">Finding lyrics…</p>
      : !result.lyrics ? <p className="mt-6 text-muted">No matching lyrics yet. This track may not be on LRCLIB.</p>
      : result.lyrics.instrumental ? <p className="mt-6 text-muted">Instrumental · no sung lyrics.</p>
      : lines.length ? <div className="mt-6">
        <button aria-pressed={follow} onClick={() => setFollow(!follow)} className="sticky top-0 mb-5 min-h-11 rounded-full bg-elevated px-4 text-xs font-semibold hover:bg-hover">{follow ? "Following the song" : "Resume following"}</button>
        <ol className="space-y-3 pb-16">{lines.map((line, i) => <li key={`${line.time}-${i}`}><button ref={i === index ? active : undefined} aria-current={i === index ? "true" : undefined}
          aria-label={`Seek to ${Math.floor(line.time / 1000)} seconds: ${line.text || "Instrumental break"}`} onClick={() => command({ action: "seek", value: line.time })}
          className={`min-h-11 text-left text-xl font-bold leading-relaxed transition-colors hover:text-mint ${i === index ? "text-mint" : "text-muted"}`}>{line.text || "♪"}</button></li>)}</ol>
      </div> : result.lyrics.plainLyrics ? <p className="mt-6 whitespace-pre-line text-lg leading-relaxed">{result.lyrics.plainLyrics}</p>
      : <p className="mt-6 text-muted">Lyrics have not been added for this track.</p>}
  </div>;
}
