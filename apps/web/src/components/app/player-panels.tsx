"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Pause, Play, Repeat, Shuffle, X } from "lucide-react";
import { defaultDsp, type DspSettings, type PlayerCommand, type PlayerState } from "@/lib/player-protocol";
import { lyricsSchema, parseLrc, type Lyrics } from "@/lib/lyrics";
import { InstallApp } from "../install-app";
import { Artwork } from "../artwork";
import { TrackAnalysis } from "./track-analysis";
import { LyricsMatch } from "./lyrics-match";

export function PlayerPanel({ title, close, children }: { title: string; close: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [close]);
  return <aside aria-label={title} className="player-panel absolute inset-y-0 right-0 z-30 flex w-full flex-col border-l border-line bg-surface sm:w-[26rem]">
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
  "Bass boost": [5.5, 4.5, 3, 1, 0, 0, 0, 0.5, 1, 1],
  Acoustic: [2, 1.5, 1, 0.5, 0, 1, 2, 2.5, 2, 1.5],
  Electronic: [4.5, 3.5, 1, -1, -1.5, 0, 1.5, 3, 4, 4.5],
  "Late night": [3.5, 2.5, 1, 0, 1, 1.5, 1, -0.5, -1.5, -2],
};
const labels = ["31", "62", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"];
export function AudioPanel({ state, command, showPlayback = true }: { state: PlayerState; command: (command: PlayerCommand) => Promise<boolean>; showPlayback?: boolean }) {
  const settings = state.dsp ?? defaultDsp;
  const [draft, setDraft] = useState<DspSettings>(settings);
  const [dirty, setDirty] = useState(false);
  const [applying, setApplying] = useState(false);
  const [feedback, setFeedback] = useState("");
  const current = dirty ? draft : settings;
  const update = (patch: Partial<DspSettings>) => { setDraft({ ...current, ...patch }); setDirty(true); setFeedback(""); };
  const apply = async (next: DspSettings) => {
    setApplying(true); setFeedback("");
    const ok = await command({ action: "dsp", settings: next });
    setApplying(false);
    if (ok) { setDirty(false); setFeedback("Sound settings applied."); }
    else setFeedback("Sound settings were not applied. Your changes are still here; try again.");
  };
  const control = "min-h-11 rounded-full bg-elevated px-4 py-2 text-sm font-semibold hover:bg-hover disabled:opacity-40";
  return <div className="space-y-7">
    {showPlayback && <div>
      <h3 className="font-semibold">Playback</h3>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className={control} disabled={!state.track} aria-pressed={state.shuffle} onClick={() => command({ action: "shuffle" })}><Shuffle className="mr-2 inline size-4" />Shuffle {state.shuffle ? "on" : "off"}</button>
        <button className={control} disabled={!state.track} aria-pressed={state.repeat > 0} onClick={() => command({ action: "repeat" })}><Repeat className="mr-2 inline size-4" />Repeat {["off", "one", "all"][state.repeat]}</button>
        <button className={control} disabled={!state.track} onClick={() => command({ action: "toggle" })}>{state.playing ? <Pause className="mr-2 inline size-4" /> : <Play className="mr-2 inline size-4" />}{state.playing ? "Pause" : "Play"}</button>
      </div>
    </div>}
    <label className="block text-sm">Volume <span className="float-right text-muted tabular">{state.volume}%</span>
      <input aria-label="Volume" type="range" min="0" max="100" value={state.volume} onChange={(event) => command({ action: "volume", value: Number(event.target.value) })} className="mt-2 h-8 w-full accent-mint" />
    </label>
    <div><h3 className="mb-3 font-semibold">Audio compatibility</h3>
      <div className="flex flex-wrap gap-2">{(["original", "mp3"] as const).map((format) => <button key={format} aria-pressed={(state.playbackFormat ?? "original") === format} className={control}
        onClick={() => command({ action: "format", format })}>{format === "original" ? "Original audio" : "MP3 compatibility"}</button>)}</div>
      <p className="mt-3 text-xs leading-relaxed text-muted">Original audio is streamed unchanged. Compatibility mode creates a private 192 kbps MP3 copy on the worker, with byte-range seeking after conversion; the original stays untouched. First play can take up to two minutes.</p>
    </div>
    {!state.dspAvailable && <p role="status" className="text-sm text-muted">Sound processing is not supported by this browser. Standard playback is still available.</p>}
    {state.dspAvailable && <fieldset disabled={applying} className="space-y-5 disabled:opacity-50">
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
      <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={current.limiter} onChange={(event) => update({ limiter: event.target.checked })} className="size-5 accent-mint" />True-peak safe limiter (-0.3 dBFS)</label>
      <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={current.loudnessContour} onChange={(event) => update({ loudnessContour: event.target.checked })} className="size-5 accent-mint" />Equal-loudness contour (warm low-volume balance)</label>
      <label className="flex flex-col gap-2 text-sm">Stereo stage
        <select aria-label="Stereo stage" value={current.stereoMode} onChange={(event) => update({ stereoMode: event.target.value as DspSettings["stereoMode"] })} className="min-h-11 rounded-md border border-line bg-elevated px-3">
          <option value="normal">Normal stereo</option>
          <option value="crossfeed">Headphone crossfeed · natural speaker image</option>
          <option value="wide">Wide stage · expanded presence</option>
        </select>
      </label>
      <label className="flex flex-col gap-2 text-sm">Transition style
        <select aria-label="Transition style" value={current.fadeMode} onChange={(event) => update({ fadeMode: event.target.value as DspSettings["fadeMode"] })} className="min-h-11 rounded-md border border-line bg-elevated px-3">
          <option value="off">Off · original track boundaries</option><option value="fixed">Fixed crossfade</option><option value="smart">Smart Fades · beat, key &amp; contour aware</option>
        </select>
      </label>
      <label className="block text-sm">Maximum overlap <span className="float-right text-muted tabular">{current.crossfade ? `${current.crossfade}s` : "Off"}</span>
        <input aria-label="Crossfade seconds" type="range" min="0" max="12" step="1" value={current.crossfade} onChange={(event) => update({ crossfade: Number(event.target.value) })} className="mt-3 h-5 w-full accent-mint" />
      </label>
      <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={current.albumSafe} onChange={(event) => update({ albumSafe: event.target.checked })} className="size-5 accent-mint" />Preserve continuous albums when not shuffled</label>
      <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={current.normalize} onChange={(event) => update({ normalize: event.target.checked })} className="size-5 accent-mint" />Loudness normalization</label>
      {current.normalize && <>
        <label className="flex flex-col gap-2 text-sm">Normalization mode
          <select aria-label="Normalization mode" value={current.normalizeMode} onChange={(event) => update({ normalizeMode: event.target.value as DspSettings["normalizeMode"] })} className="min-h-11 rounded-md border border-line bg-elevated px-3">
            <option value="auto">Auto · album dynamics in order, track balance in mixes</option>
            <option value="track">Track · match every song to target loudness</option>
            <option value="album">Album · preserve quiet interludes and album arc</option>
          </select>
        </label>
        <label className="block text-sm">Target loudness <span className="float-right text-muted tabular">{current.targetLufs} LUFS</span>
          <input aria-label="Target loudness" type="range" min="-23" max="-9" step="1" value={current.targetLufs} onChange={(event) => update({ targetLufs: Number(event.target.value) })} className="mt-3 h-5 w-full accent-mint" />
        </label>
      </>}
      <p className="max-w-prose text-xs leading-relaxed text-muted">Mint Smart Fades use measured silence, MixRamp contours, BPM beatgrids, and Camelot harmonic compatibility. Missing analysis uses a short fixed fade; missing loudness data applies no normalization. EQ, contour, and limiter protect headroom. Repeat-one never fades.</p>
      <p role="status" className="text-xs text-muted">{state.transitionDetail ?? "Transitions off"}{current.normalize ? ` · gain ${(state.normalizationDb ?? 0).toFixed(1)} dB` : ""}</p>
      <div className="flex flex-wrap gap-2">
        <button disabled={!dirty} className="min-h-11 rounded-full bg-mint px-5 py-2 text-sm font-bold text-mint-ink hover:bg-mint-strong disabled:opacity-40"
          onClick={() => void apply(current)}>{applying ? "Applying…" : "Apply sound"}</button>
        <button className={control} onClick={() => void apply(defaultDsp)}>Reset / bypass</button>
      </div>
      <p role="status" className="text-sm text-muted">{feedback || (dirty ? "Unsaved sound changes" : "Settings are saved on this device.")}</p>
    </fieldset>}
    <TrackAnalysis state={state} command={command} />
    <div><h3 className="mb-3 font-semibold">Listen on your phone</h3><InstallApp /><p className="mt-3 text-xs leading-relaxed text-muted">Audio settings stay on this device for your account. Installation needs HTTPS. Save songs in Downloads before going offline.</p></div>
  </div>;
}

export function QueueContents({ state, command }: { state: PlayerState; command: (command: PlayerCommand) => void }) {
  const current = state.queue.findIndex((track) => track.queueId === state.track?.queueId);
  const upcoming = current >= 0 ? state.queue.slice(current + 1) : state.queue;
  const remaining = current >= 0 ? Math.max(0, state.queueTotal - state.queueOffset - current - 1) : state.queueTotal;
  return <div>
    {state.track && <div className="mb-6">
      <h3 className="mb-3 text-sm font-semibold text-muted">Now playing</h3>
      <div className="flex items-center gap-3">
        <Artwork track={{ artworkUrl: state.track.thumb ?? "" }} className="size-12" />
        <div className="min-w-0"><p className="truncate font-semibold text-mint">{state.track.title}</p><p className="truncate text-sm text-muted">{state.track.artist}</p></div>
      </div>
    </div>}
    <div className="mb-3 flex items-center justify-between gap-3">
      <h3 className="text-sm font-semibold">Up next <span className="ml-1 text-muted tabular">· {remaining}</span></h3>
      {remaining > 0 && <button onClick={() => command({ action: "clear" })} className="min-h-11 rounded-full px-3 text-xs text-muted hover:bg-hover hover:text-fg">Clear upcoming</button>}
    </div>
    {remaining > upcoming.length && <p className="mb-3 text-xs text-muted">Showing the next {upcoming.length} of {remaining} songs.</p>}
    <ol className="space-y-1">
      {upcoming.map((track, index) => <li key={track.queueId} className="group flex items-center gap-1 rounded-md hover:bg-hover">
        <button onClick={() => command({ action: "skip", queueId: track.queueId! })} className="flex min-w-0 flex-1 items-center gap-3 p-2 text-left" aria-label={`Play ${track.title}`}>
          <Artwork track={{ artworkUrl: track.thumb ?? "" }} className="size-10" />
          <span className="min-w-0"><span className="block truncate text-sm font-semibold">{track.title}</span><span className="block truncate text-xs text-muted">{track.artist}</span></span>
        </button>
        <button aria-label={`Move ${track.title} earlier`} disabled={index === 0} onClick={() => command({ action: "move", queueId: track.queueId!, before: upcoming[index - 1]!.queueId! })} className="grid size-9 shrink-0 place-items-center rounded-full text-muted hover:bg-elevated hover:text-fg disabled:opacity-30"><ArrowUp className="size-4" /></button>
        <button aria-label={`Move ${track.title} later`} disabled={index === upcoming.length - 1} onClick={() => command({ action: "move", queueId: upcoming[index + 1]!.queueId!, before: track.queueId! })} className="grid size-9 shrink-0 place-items-center rounded-full text-muted hover:bg-elevated hover:text-fg disabled:opacity-30"><ArrowDown className="size-4" /></button>
        <button aria-label={`Remove ${track.title} from queue`} onClick={() => command({ action: "remove", queueId: track.queueId! })} className="grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-elevated hover:text-fg"><X className="size-4" /></button>
      </li>)}
    </ol>
    {!upcoming.length && <p className="py-6 text-sm leading-relaxed text-muted">{state.track ? "You're all caught up. Add songs from the library to keep listening." : "Play a song or album to start your queue."}</p>}
  </div>;
}

export function LyricsPanel({ state, command }: { state: PlayerState; command: (command: PlayerCommand) => void }) {
  const id = state.track?.id;
  return id ? <TrackLyrics key={id} id={id} state={state} command={command} /> : <p className="text-sm text-muted">Choose a song to see its lyrics.</p>;
}
function TrackLyrics({ id, state, command }: { id: string; state: PlayerState; command: (command: PlayerCommand) => void }) {
  const [result, setResult] = useState<{ lyrics: Lyrics | null; offsetMs: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [retryRemaining, setRetryRemaining] = useState(0);
  const [follow, setFollow] = useState(true);
  const active = useRef<HTMLButtonElement>(null);
  const lines = useMemo(() => parseLrc(result?.lyrics?.syncedLyrics ?? ""), [result]);
  const index = lines.findLastIndex((line) => line.time + (result?.offsetMs ?? 0) <= state.time);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/player/lyrics/${id}`, { signal: controller.signal, cache: "no-store" }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) {
        setRetryRemaining(Number(response.headers.get("retry-after")) || 5);
        throw new Error(body.error ?? "Lyrics could not load.");
      }
      if (!controller.signal.aborted) setResult({ lyrics: body.lyrics === null ? null : lyricsSchema.parse(body.lyrics), offsetMs: Number(body.offsetMs) || 0 });
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
    <LyricsMatch id={id} title={`${state.track?.title ?? ""} ${state.track?.artist ?? ""}`} offset={result?.offsetMs ?? 0} refresh={() => { setError(null); setResult(null); setRetry((value) => value + 1); }} />
    {error ? <div role="alert" className="mt-6 text-sm"><p className="text-warn">{error}</p><button disabled={retryRemaining > 0} className="mt-3 min-h-11 rounded-full bg-elevated px-4 hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
      onClick={() => { setError(null); setResult(null); setRetry((n) => n + 1); }}>{retryRemaining > 0 ? `Retry in ${retryRemaining}s` : "Retry lyrics"}</button></div>
      : !result ? <p role="status" className="mt-6 text-sm text-muted">Finding lyrics…</p>
      : !result.lyrics ? <p className="mt-6 text-muted">No matching lyrics yet. This track may not be on LRCLIB.</p>
      : result.lyrics.instrumental ? <p className="mt-6 text-muted">Instrumental · no sung lyrics.</p>
      : lines.length ? <div className="mt-6">
        <button aria-pressed={follow} onClick={() => setFollow(!follow)} className="sticky top-0 mb-5 min-h-11 rounded-full bg-elevated px-4 text-xs font-semibold hover:bg-hover">{follow ? "Following the song" : "Resume following"}</button>
        <ol className="space-y-3 pb-16">{lines.map((line, i) => <li key={`${line.time}-${i}`}><button ref={i === index ? active : undefined} aria-current={i === index ? "true" : undefined}
          aria-label={`Seek to ${Math.floor((line.time + (result?.offsetMs ?? 0)) / 1000)} seconds: ${line.text || "Instrumental break"}`} onClick={() => command({ action: "seek", value: Math.max(0, line.time + (result?.offsetMs ?? 0)) })}
          className={`min-h-11 text-left text-xl font-bold leading-relaxed transition-colors hover:text-mint ${i === index ? "text-mint" : "text-muted"}`}>{line.text || "♪"}</button></li>)}</ol>
      </div> : result.lyrics.plainLyrics ? <p className="mt-6 whitespace-pre-line text-lg leading-relaxed">{result.lyrics.plainLyrics}</p>
      : <p className="mt-6 text-muted">Lyrics have not been added for this track.</p>}
  </div>;
}
