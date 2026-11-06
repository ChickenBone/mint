"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Check, MonitorSpeaker, Pause, Play, SkipBack, SkipForward, X } from "lucide-react";
import type { DeviceCommand } from "@mint/core/devices";
import type { DeviceStore } from "@/lib/devices-store";
import { getLocalDeviceId, handoffToDevice } from "@/lib/device-client";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

type Devices = Awaited<ReturnType<DeviceStore["list"]>>;
type Device = Awaited<ReturnType<DeviceStore["getDevice"]>>;
type Parties = Awaited<ReturnType<DeviceStore["listParties"]>>;
type Party = Parties[number];
type Track = { id: string; title: string; artist?: string };
const button = "inline-flex min-h-10 items-center justify-center gap-2 rounded-full px-4 text-sm font-semibold ring-1 ring-line hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40";
const primary = "inline-flex min-h-10 items-center justify-center gap-2 rounded-full bg-mint px-5 text-sm font-bold text-mint-ink hover:bg-mint-strong disabled:cursor-not-allowed disabled:opacity-40";
const input = "h-11 w-full min-w-0 rounded-lg bg-elevated px-3 text-sm text-fg ring-1 ring-line placeholder:text-faint focus:ring-mint";
const duration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

async function api<T>(path: string, value?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: value === undefined ? "GET" : "POST", cache: "no-store", credentials: "same-origin",
    ...(value === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(value) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Connection failed. Try again.");
  return result as T;
}

async function confirmCommand(path: string, value: unknown) {
  const admitted = await api<{ id: string; expiresAt: string }>(path, value);
  while (Date.now() < Date.parse(admitted.expiresAt)) {
    const result = await api<{ status: string; error: string | null }>(`/api/devices/commands/${admitted.id}`);
    if (result.status === "succeeded") return;
    if (result.status === "failed" || result.status === "expired") throw new Error(result.error || "Device could not apply that action.");
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  throw new Error("Device did not confirm the action. Open Mint on that device and try again.");
}

function TrackPicker({ disabled, add }: { disabled: boolean; add: (track: Track) => Promise<void> }) {
  const [query, setQuery] = useState(""), [tracks, setTracks] = useState<Track[]>([]), [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!query.trim()) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/player/catalog?type=track&size=12&q=${encodeURIComponent(query)}`, {
          cache: "no-store", credentials: "same-origin", signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Search failed.");
        setTracks(result.items ?? []);
        setError("");
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Search failed.");
      }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);
  return (
    <div className="mt-5">
      <label className="mb-2 block text-sm font-semibold">
        Add available music
        <input className={`${input} mt-2`} value={query} disabled={disabled || busy} maxLength={100}
          placeholder="Search songs or artists" onChange={(event) => { setQuery(event.target.value); setTracks([]); }} />
      </label>
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      {query.trim() && tracks.length > 0 && (
        <ul className="mt-2 max-h-64 overflow-auto divide-y divide-line rounded-lg bg-elevated">
          {tracks.map((track) => (
            <li key={track.id} className="flex items-center gap-3 p-3">
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{track.title}</span><span className="block truncate text-sm text-muted">{track.artist}</span></span>
              <button className={button} disabled={disabled || busy} onClick={async () => {
                setBusy(true);
                try { await add(track); setQuery(""); setTracks([]); setError(""); }
                catch (failure) { setError(failure instanceof Error ? failure.message : "Track could not be added."); }
                finally { setBusy(false); }
              }}>Add<span className="sr-only"> {track.title}</span></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function QueueEditor({ queue, labels, disabled, update, currentIndex, progressive }: {
  queue: string[]; labels: Track[]; disabled: boolean; currentIndex?: number;
  update: (queue: string[], currentIndex: number) => Promise<void>;
  progressive?: { total: number; offset: number; entryIds: string[]; edit: (edit: Extract<DeviceCommand, { action: "queue-edit" }>["edit"]) => Promise<void> };
}) {
  const [limit, setLimit] = useState(30);
  const [loadedTracks, setLoadedTracks] = useState<Track[]>([]), [metadataError, setMetadataError] = useState("");
  const byId = new Map([...labels, ...loadedTracks].map((track) => [track.id, track]));
  const missingIds = [...new Set(queue.slice(0, limit).filter((id) => !byId.has(id)))].join(",");
  useEffect(() => {
    if (!missingIds) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const ids = missingIds.split(","), found: Track[] = [];
        for (let offset = 0; offset < ids.length; offset += 5000) {
          const response = await fetch("/api/player/items", {
            method: "POST", cache: "no-store", credentials: "same-origin", signal: controller.signal,
            headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: ids.slice(offset, offset + 5000) }),
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "Queue titles could not load.");
          found.push(...result.items);
        }
        setLoadedTracks((previous) => [...new Map([...previous, ...found].map((track) => [track.id, track])).values()]);
        setMetadataError("");
      } catch (failure) {
        if (!controller.signal.aborted) setMetadataError(failure instanceof Error ? failure.message : "Queue titles could not load.");
      }
    })();
    return () => controller.abort();
  }, [missingIds]);
  return (
    <div className="mt-5">
      <h4 className="font-semibold">Queue <span className="text-muted tabular">· {(progressive?.total ?? queue.length).toLocaleString()} tracks</span></h4>
      {progressive && <p className="mt-2 text-xs text-muted">Showing the window around playback. The full collection stays on the server and loads as needed.</p>}
      {!queue.length && <p className="mt-2 text-sm text-muted">Search available music below to build this queue.</p>}
      {metadataError && <p className="mt-2 text-sm text-warn">{metadataError} Queue order is unchanged.</p>}
      <ol className="mt-3 divide-y divide-line">
        {queue.slice(0, limit).map((id, index) => {
          const track = byId.get(id);
          return (
            <li key={`${id}-${index}`} className="flex min-w-0 items-center gap-2 py-2">
              <span className="w-10 shrink-0 text-right text-xs text-faint tabular">{(progressive?.offset ?? 0) + index + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{track?.title ?? (index === currentIndex ? "Current track" : `Track ${index + 1}`)}</span>
                <span className="block truncate text-xs text-muted">{track?.artist ?? (index === currentIndex ? "Playing on this device" : "Available in Mint")}</span>
              </span>
              <button className="rounded-full p-2 text-muted hover:bg-hover hover:text-fg disabled:opacity-30" aria-label={`Move track ${index + 1} up`} disabled={disabled || index === 0 || Boolean(progressive && index <= (currentIndex ?? 0) + 1)} onClick={() => {
                if (progressive) { void progressive.edit({ action: "move", entryId: progressive.entryIds[index]!, before: progressive.entryIds[index - 1]! }); return; }
                const next = [...queue];
                [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                const position = currentIndex === index ? index - 1 : currentIndex === index - 1 ? index : currentIndex ?? 0;
                void update(next, position);
              }}><ArrowUp className="size-4" aria-hidden /></button>
              <button className="rounded-full p-2 text-muted hover:bg-hover hover:text-fg disabled:opacity-30" aria-label={`Move track ${index + 1} down`} disabled={disabled || index === queue.length - 1 || Boolean(progressive && index <= (currentIndex ?? 0))} onClick={() => {
                if (progressive) { void progressive.edit({ action: "move", entryId: progressive.entryIds[index + 1]!, before: progressive.entryIds[index]! }); return; }
                const next = [...queue];
                [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
                const position = currentIndex === index ? index + 1 : currentIndex === index + 1 ? index : currentIndex ?? 0;
                void update(next, position);
              }}><ArrowDown className="size-4" aria-hidden /></button>
              <button className="rounded-full p-2 text-muted hover:bg-hover hover:text-danger disabled:opacity-30" aria-label={`Remove track ${index + 1}`} disabled={disabled} onClick={() => {
                if (progressive) { void progressive.edit({ action: "remove", entryId: progressive.entryIds[index]! }); return; }
                const next = queue.filter((_, n) => n !== index);
                const position = Math.max(0, Math.min(next.length - 1, (currentIndex ?? 0) - (index < (currentIndex ?? 0) ? 1 : 0)));
                void update(next, position);
              }}><X className="size-4" aria-hidden /></button>
            </li>
          );
        })}
      </ol>
      {queue.length > limit && <button className={`${button} mt-3`} onClick={() => setLimit((value) => value + 100)}>Show more tracks</button>}
      <TrackPicker disabled={disabled} add={async (track) => { if (progressive) await progressive.edit({ action: "append", trackId: track.id }); else await update([...queue, track.id], currentIndex ?? 0); }} />
    </div>
  );
}

function DeviceControls({ device, refresh, announce, busy, run }: {
  device: Device; refresh: () => Promise<void>; announce: (message: string) => void; busy: boolean;
  run: (task: () => Promise<void>, success?: string) => Promise<void>;
}) {
  const [name, setName] = useState(device.name), [volume, setVolume] = useState(device.state.volume);
  const [seek, setSeek] = useState(device.state.time);
  const [confirmDisconnectOpen, setConfirmDisconnectOpen] = useState(false);
  const send = async (command: DeviceCommand) => {
    await run(async () => { await confirmCommand(`/api/devices/${device.id}/commands`, command); await refresh(); }, "Device confirmed the change.");
  };
  return (
    <section aria-label={`Controls for ${device.name}`} className="min-w-0 border-t border-line pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-xl font-bold">{device.name}</h3>
        <span className={device.online ? "text-sm text-mint" : "text-sm text-warn"}>{device.online ? "Awake and connected" : "Asleep or disconnected"}</span>
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        <button className={button} disabled={busy || !device.online} aria-label="Previous track" onClick={() => void send({ action: "previous" })}><SkipBack className="size-4" aria-hidden /></button>
        <button className={primary} disabled={busy || !device.online} onClick={() => void send({ action: device.state.playing ? "pause" : "play" })}>
          {device.state.playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
          {device.state.playing ? "Pause" : "Play"}
        </button>
        <button className={button} disabled={busy || !device.online} aria-label="Next track" onClick={() => void send({ action: "next" })}><SkipForward className="size-4" aria-hidden /></button>
        <button className={button} disabled={busy || !device.online || device.id === getLocalDeviceId()} onClick={() => void run(
          async () => { announce("Waiting for the destination to confirm playback…"); await handoffToDevice(device.id); await refresh(); },
          "Playback moved. This tab paused after the destination confirmed.",
        )}>Move this tab&apos;s playback here</button>
      </div>
      <p className="mt-3 max-w-2xl text-sm text-muted">Moving playback carries the full queue and position. This tab keeps playing until the destination confirms. If autoplay is blocked, press Play on the destination first.</p>
      <div className="mt-6 grid gap-5 sm:grid-cols-2">
        <label className="text-sm font-semibold">Volume <span className="text-muted tabular">{Math.round(volume)}%</span>
          <input type="range" min={0} max={100} value={volume} disabled={busy || !device.online} className="mt-3 block w-full accent-mint"
            onChange={(event) => setVolume(Number(event.target.value))} onPointerUp={() => void send({ action: "volume", value: volume })}
            onKeyUp={(event) => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) void send({ action: "volume", value: volume }); }} />
        </label>
        <form className="flex items-end gap-3" onSubmit={(event) => { event.preventDefault(); void send({ action: "seek", value: seek }); }}>
          <label className="min-w-0 flex-1 text-sm font-semibold">Position <span className="text-muted tabular">· {duration(device.state.duration)}</span>
            <input type="number" min={0} max={device.state.duration || undefined} step={1} className={`${input} mt-2`} value={Math.floor(seek)}
              disabled={busy || !device.online} onChange={(event) => setSeek(Number(event.target.value))} />
          </label>
          <button className={button} disabled={busy || !device.online}>Seek</button>
        </form>
      </div>
      <form className="mt-6 flex items-end gap-3" onSubmit={(event) => { event.preventDefault(); void run(async () => {
        await api(`/api/devices/${device.id}/rename`, { name }); await refresh();
      }, "Device renamed."); }}>
        <label className="min-w-0 flex-1 text-sm font-semibold">Device name
          <input className={`${input} mt-2`} value={name} maxLength={80} required disabled={busy} onChange={(event) => setName(event.target.value)} />
        </label>
        <button className={button} disabled={busy}>Save name</button>
      </form>
      <QueueEditor queue={device.state.queue} labels={[]} currentIndex={device.state.currentIndex} disabled={busy || !device.online}
        progressive={device.state.queueContext ? { total: device.state.queueContext.total, offset: device.state.queueContext.offset,
          entryIds: device.state.queueEntryIds ?? [], edit: async (edit) => { await send({ action: "queue-edit", edit }); } } : undefined}
        update={async (queue, currentIndex) => { await send({ action: "queue", trackIds: queue, currentIndex }); }} />
      <button className={`${button} mt-6 text-danger`} disabled={busy} onClick={() => setConfirmDisconnectOpen(true)}>Disconnect device</button>
      <ConfirmDialog
        open={confirmDisconnectOpen}
        onClose={() => setConfirmDisconnectOpen(false)}
        title={`Disconnect ${device.name}?`}
        description={`Disconnect ${device.name}? Any party on this device will end.`}
        confirmLabel="Disconnect device"
        tone="danger"
        busy={busy}
        onConfirm={async () => {
          setConfirmDisconnectOpen(false);
          await run(async () => {
            await api(`/api/devices/${device.id}/revoke`, {}); await refresh();
          }, "Device disconnected. Reload Mint on that device to reconnect.");
        }}
      />
    </section>
  );
}

function PartyControls({ party, refresh, run, busy }: {
  party: Party; refresh: () => Promise<void>; busy: boolean;
  run: (task: () => Promise<void>, success?: string) => Promise<void>;
}) {
  const [invite, setInvite] = useState<string | null>(null);
  const [confirmEndOpen, setConfirmEndOpen] = useState(false);
  const [pendingRemoveMember, setPendingRemoveMember] = useState<{ userId: string; name: string } | null>(null);
  const hostAction = (value: unknown, success: string) => run(async () => {
    await api(`/api/parties/${party.id}/control`, value); await refresh();
  }, success);
  const editable = party.isHost || party.guestsCanEdit;
  return (
    <section aria-label={party.name} className="mt-6 border-t border-line pt-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-xl font-bold">{party.name}</h3>
          <p className="mt-1 text-sm text-muted">{party.output?.name ?? "Output unavailable"} · {party.output?.online ? "Connected" : "Disconnected"} · {party.participants.length} {party.participants.length === 1 ? "person" : "people"}</p>
        </div>
        <span className="text-sm text-muted">{party.isHost ? "You are the host" : editable ? "You can edit the queue" : "Host controls the queue"}</span>
      </div>
      {party.isHost ? (
        <div className="mt-5">
          <div className="flex flex-wrap gap-2">
            {(["play", "pause", "next"] as const).map((action) => <button key={action} className={button} disabled={busy || !party.output?.online}
              onClick={() => void run(async () => { await confirmCommand(`/api/parties/${party.id}/control`, { action }); await refresh(); }, "Party device confirmed the change.")}>{action === "play" ? "Play" : action === "pause" ? "Pause" : "Next"}</button>)}
            <button className={primary} disabled={busy || !party.output?.online} onClick={() => void run(async () => {
              await confirmCommand(`/api/parties/${party.id}/control`, { action: "apply-queue", revision: party.revision }); await refresh();
            }, "Shared queue confirmed on the party device.")}>Apply shared queue</button>
          </div>
          <p className="mt-3 text-sm text-muted">Queue edits are shared immediately. Apply them to replace the host device&apos;s playback queue, then press Play if needed. No guest device plays automatically.</p>
          <label className="mt-5 flex items-center gap-3 text-sm">
            <input type="checkbox" className="size-4 accent-mint" checked={party.guestsCanEdit} disabled={busy}
              onChange={(event) => void hostAction({ action: "permissions", enabled: event.target.checked }, "Guest queue permission updated.")} />
            Let guests add, remove and reorder tracks
          </label>
          <div className="mt-5 flex flex-wrap gap-2">
            <button className={button} disabled={busy} onClick={() => void run(async () => {
              const result = await api<{ code: string }>(`/api/parties/${party.id}/invite`, {}); setInvite(result.code);
            }, "Invitation created. Only approved Mint members can join.")}>Create invitation</button>
            <button className={button} disabled={busy} onClick={() => void run(async () => {
              await api(`/api/parties/${party.id}/invite`, { revoke: true }); setInvite(null);
            }, "Invitation revoked. Existing participants are unchanged.")}>Revoke invitation</button>
            <button className={`${button} text-danger`} disabled={busy} onClick={() => setConfirmEndOpen(true)}>End party</button>
          </div>
          {invite && <label className="mt-4 block text-sm font-semibold">Invitation code · valid for up to one hour
            <input readOnly value={invite} className={`${input} mt-2`} onFocus={(event) => event.target.select()} />
            <span className="mt-1 block text-xs font-normal text-muted">Share privately with an approved Mint member. Creating another invitation revokes this one.</span>
          </label>}
        </div>
      ) : <button className={`${button} mt-4`} disabled={busy} onClick={() => void run(async () => { await api(`/api/parties/${party.id}/leave`, {}); await refresh(); }, "You left the party.")}>Leave party</button>}
      <ul className="mt-5 flex flex-wrap gap-2" aria-label="Party participants">
        {party.participants.map((person) => <li key={person.userId} className="flex items-center gap-1 rounded-full bg-elevated py-1 pl-3 pr-2 text-sm">
          {person.name}{person.userId === party.hostId ? " · host" : ""}
          {party.isHost && person.userId !== party.hostId && <button className="rounded-full p-2 text-muted hover:text-danger" aria-label={`Remove ${person.name}`}
            disabled={busy} onClick={() => setPendingRemoveMember({ userId: person.userId, name: person.name })}><X className="size-3" aria-hidden /></button>}
        </li>)}
      </ul>
      <ConfirmDialog
        open={confirmEndOpen}
        onOpenChange={setConfirmEndOpen}
        title="End this party?"
        description="This ends the party and revokes its invitation code. Playback stays on its current device."
        confirmLabel="End party"
        loading={busy}
        onConfirm={async () => {
          setConfirmEndOpen(false);
          await hostAction({ action: "end" }, "Party ended.");
        }}
      />
      <ConfirmDialog
        open={pendingRemoveMember !== null}
        onOpenChange={(open) => { if (!open) setPendingRemoveMember(null); }}
        title={pendingRemoveMember ? `Remove ${pendingRemoveMember.name}?` : "Remove participant?"}
        description="This removes the participant from the party and revokes the current invitation code."
        confirmLabel="Remove participant"
        loading={busy}
        onConfirm={async () => {
          const target = pendingRemoveMember;
          setPendingRemoveMember(null);
          if (!target) return;
          await hostAction({ action: "remove-member", userId: target.userId }, "Participant removed and invitation revoked.");
        }}
      />
      <QueueEditor queue={party.queue} labels={party.queueTracks} disabled={busy || !editable} update={async (queue) => {
        await run(async () => { await api(`/api/parties/${party.id}/queue`, { revision: party.revision, queue }); await refresh(); }, "Shared queue updated.");
      }} />
    </section>
  );
}

export function DevicesPanel({ initialDevices, initialParties }: { initialDevices: Devices; initialParties: Parties }) {
  const [devices, setDevices] = useState(initialDevices), [parties, setParties] = useState(initialParties);
  const [selected, setSelected] = useState<string | null>(initialDevices[0]?.id ?? null), [device, setDevice] = useState<Device | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [partyName, setPartyName] = useState("Listening together"), [code, setCode] = useState("");
  const refresh = useCallback(async () => {
    const [nextDevices, nextParties] = await Promise.all([api<Devices>("/api/devices"), api<Parties>("/api/parties")]);
    setDevices(nextDevices); setParties(nextParties);
    if (selected && nextDevices.some((row) => row.id === selected)) setDevice(await api<Device>(`/api/devices/${selected}`));
    else { setDevice(null); setSelected(nextDevices[0]?.id ?? null); }
  }, [selected]);
  useEffect(() => {
    let active = true;
    if (!selected) return;
    api<Device>(`/api/devices/${selected}`).then((value) => { if (active) setDevice(value); })
      .catch((failure) => { if (active) setError(failure instanceof Error ? failure.message : "Device could not load."); });
    return () => { active = false; };
  }, [selected]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!busy && document.visibilityState === "visible") void refresh().catch((failure) => setError(failure instanceof Error ? failure.message : "Connection lost."));
    }, 6000);
    return () => clearInterval(timer);
  }, [refresh, busy]);
  async function run(task: () => Promise<void>, success?: string) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await task(); if (success) setNotice(success); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Action failed."); await refresh().catch(() => undefined); }
    finally { setBusy(false); }
  }
  return (
    <div className="max-w-5xl">
      <div className="sticky top-0 z-10 rounded-lg bg-surface py-2" aria-live="polite" aria-atomic>
        {error && <p className="text-sm text-danger" role="alert">{error}</p>}
        {notice && <p className="flex items-center gap-2 text-sm text-mint"><Check className="size-4 shrink-0" aria-hidden />{notice}</p>}
        {busy && <p className="text-sm text-muted">Waiting for confirmation…</p>}
      </div>
      <section aria-labelledby="your-devices">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="your-devices" className="text-2xl font-bold">Your devices</h2>
          <button className={button} disabled={busy} onClick={() => void run(refresh)}>Refresh</button>
        </div>
        {!devices.length && <p className="mt-4 text-muted">Keep Mint open on a signed-in device. It will appear here once its player connects.</p>}
        <div className="my-5 flex flex-wrap gap-2" aria-label="Choose a device">
          {devices.map((row) => <button key={row.id} className={`${button} ${selected === row.id ? "bg-elevated text-fg ring-mint" : "text-muted"}`}
            aria-pressed={selected === row.id} disabled={busy} onClick={() => { setSelected(row.id); setDevice(null); }}>
            <MonitorSpeaker className="size-4" aria-hidden />{row.name}{row.id === getLocalDeviceId() ? " · this tab" : ""}
            <span className={`size-1.5 rounded-full ${row.online ? "bg-mint" : "bg-faint"}`} aria-label={row.online ? "Connected" : "Disconnected"} />
          </button>)}
        </div>
        {device && device.id === selected && <DeviceControls key={device.id} device={device} refresh={refresh} announce={setNotice} busy={busy} run={run} />}
      </section>
      <section aria-labelledby="parties" className="mt-12 border-t border-line pt-8">
        <h2 id="parties" className="text-2xl font-bold">Listen together</h2>
        <p className="mt-2 max-w-2xl text-muted">An opt-in shared queue, one host and one playback device. This is not synchronized multi-device audio. Parties end after 12 hours.</p>
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <form onSubmit={(event) => { event.preventDefault(); if (selected) void run(async () => {
            await api("/api/parties", { name: partyName, deviceId: selected }); await refresh();
          }, "Party started. Create an invitation to add approved members."); }}>
            <label className="text-sm font-semibold">Party name<input className={`${input} mt-2`} value={partyName} required maxLength={80} disabled={busy} onChange={(event) => setPartyName(event.target.value)} /></label>
            <p className="mt-2 text-sm text-muted">Playback device: {device?.name ?? "Choose a connected device above"}</p>
            <button className={`${primary} mt-3`} disabled={busy || !device?.online}>Start party on this device</button>
          </form>
          <form onSubmit={(event) => { event.preventDefault(); void run(async () => {
            await api("/api/parties/join", { code }); setCode(""); await refresh();
          }, "You joined the party. Only its playback device plays audio."); }}>
            <label className="text-sm font-semibold">Invitation code<input className={`${input} mt-2`} value={code} required maxLength={120} disabled={busy} autoComplete="off" onChange={(event) => setCode(event.target.value)} /></label>
            <p className="mt-2 text-sm text-muted">Ask the host for a private invitation.</p>
            <button className={`${button} mt-3`} disabled={busy}>Join party</button>
          </form>
        </div>
        {parties.map((party) => <PartyControls key={party.id} party={party} refresh={refresh} run={run} busy={busy} />)}
      </section>
    </div>
  );
}
