"use client";

import { useEffect, useState } from "react";
import { MonitorSpeaker, Smartphone } from "lucide-react";
import { connectableDeviceSchema, type ConnectableDevice } from "@mint/client";
import { z } from "zod";
import { Dialog } from "../ui/interactive";
import { activeOutput, connectToDevice, getLocalDeviceId } from "@/lib/device-client";

export function PlayerDevices({ className }: { className?: string }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [retry, setRetry] = useState(0);
  const [devices, setDevices] = useState<ConnectableDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null), [message, setMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const response = await fetch("/api/devices", { cache: "no-store", signal: controller.signal });
        const body: unknown = await response.json();
        if (!response.ok) {
          const failure = z.object({ error: z.string() }).safeParse(body);
          throw new Error(failure.success ? failure.data.error : "Devices could not load.");
        }
        const rows = z.array(connectableDeviceSchema).max(30).parse(body);
        if (!controller.signal.aborted) { setDevices(rows); setLoadError(null); }
      } catch (failure) {
        if (!controller.signal.aborted) setLoadError(failure instanceof Error ? failure.message : "Devices could not load.");
      } finally { if (!controller.signal.aborted) timer = setTimeout(load, 2000); }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [open, retry]);
  async function move(id: string) {
    setBusy(true); setError(null); setMessage("Waiting for the destination to confirm playback.");
    try { await connectToDevice(id); setMessage("Playback moved."); }
    catch (failure) { setMessage(null); setError(failure instanceof Error ? failure.message : "Playback could not move."); }
    finally { setBusy(false); }
  }
  return <>
    <button type="button" aria-label="Devices" aria-haspopup="dialog" aria-expanded={open} title="Devices" className={className}
      onClick={() => { setOpen(true); setDevices(null); setError(null); setLoadError(null); setMessage(null); }}><MonitorSpeaker className="size-5" aria-hidden /></button>
    <Dialog open={open} onOpenChange={setOpen} title="Connect to a device">
      <div onKeyDown={(event) => event.stopPropagation()}>
        <p className="mb-4 text-sm text-muted">Choose an awake player for your music. Playback continues until the destination confirms.</p>
        {!devices && !loadError ? <p role="status">Loading devices...</p> : null}
        <div className="space-y-2">{devices?.map((device) => {
          const local = device.id === getLocalDeviceId();
          const selected = activeOutput(devices ?? [])?.id === device.id;
          const Icon = device.kind === "web" ? MonitorSpeaker : Smartphone;
          return <button key={device.id} type="button" aria-pressed={selected} disabled={busy || selected || !device.online}
            onClick={() => void move(device.id)} className="flex min-h-12 w-full items-center gap-3 rounded-control bg-surface p-3 text-left hover:bg-hover disabled:opacity-60">
            <Icon className="size-5 shrink-0" aria-hidden /><span className="min-w-0 break-words"><span className="block font-semibold">{device.name}</span>
              <span className="text-sm text-muted">{local ? "This Web player" : device.online ? device.state.playing ? "Playing" : "Connected" : "Offline - open Mint to connect"}</span></span>
          </button>;
        })}</div>
        {devices && !devices.length ? <p className="text-sm text-muted">No connected players. Open Mint on another signed-in device.</p> : null}
        {error || loadError ? <p role="alert" className="mt-4 text-sm text-danger">{error || loadError}</p> : null}
        {message ? <p role="status" className="mt-4 text-sm text-mint">{message}</p> : null}
        <button type="button" disabled={busy} className="mt-4 min-h-12 rounded-control px-4 font-semibold hover:bg-hover" onClick={() => setRetry((value) => value + 1)}>Refresh devices</button>
        <p className="mt-4 text-xs text-muted">Web players disappear on disconnect. Installed apps remain for 30 days after their last Mint connection.</p>
      </div>
    </Dialog>
  </>;
}
