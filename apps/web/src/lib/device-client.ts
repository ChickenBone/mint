import {
  deviceCommandSchema, deviceStateSchema, confirmsHandoff,
  type DeviceCommand, type DeviceCommandEnvelope, type DeviceHandoff, type DeviceState,
} from "@mint/core/devices";

type BridgeOptions = {
  memberId: string;
  getState: () => DeviceState;
  execute: (command: DeviceCommand, signal?: AbortSignal) => Promise<void>;
  applyHandoff: (handoff: DeviceHandoff, signal?: AbortSignal) => Promise<void>;
  error: (message: string) => void;
  fetcher?: typeof fetch;
  name?: string;
  pollMs?: number;
};
export type DeviceBridge = {
  readonly deviceId: string | null;
  dispose: () => void;
  handoffTo: (destinationId: string) => Promise<void>;
};
let activeBridge: DeviceBridge | null = null;
export const getLocalDeviceId = () => activeBridge?.deviceId ?? null;
export function handoffToDevice(id: string) {
  if (!activeBridge) return Promise.reject(new Error("Open Mint's player in this tab before moving playback."));
  return activeBridge.handoffTo(id);
}
const message = (error: unknown) => error instanceof Error ? error.message : "Device control failed.";
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const playbackIdentity = (state: DeviceState) => JSON.stringify([state.trackId, state.queueContext ?? state.queue, state.queueContext?.position ?? state.currentIndex, state.playing]);

export function startDeviceBridge(options: BridgeOptions): DeviceBridge {
  const load = options.fetcher ?? fetch;
  let stopped = false, device: { id: string; token: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: AbortController | null = null;
  let executing: AbortController | null = null;
  let lastSequence = 0, handoffBusy = false, reported = "", lastQueue = "";
  const seen = new Set<string>();

  function report(error: unknown) {
    const text = message(error);
    if (!stopped && text !== reported) { reported = text; options.error(text); }
  }
  async function request<T>(path: string, value?: unknown, signal?: AbortSignal, keepalive = false): Promise<T> {
    const response = await load(`/api/devices${path}`, {
      method: value === undefined ? "GET" : "POST", cache: "no-store", credentials: "same-origin", signal, keepalive,
      ...(value === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(value) }),
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(typeof result.error === "string" ? result.error : "Device service did not respond.");
      Object.assign(error, { status: response.status });
      throw error;
    }
    return result as T;
  }
  function state() { return deviceStateSchema.parse(options.getState()); }
  function browserName() {
    if (options.name) return options.name;
    if (typeof navigator === "undefined") return "Mint browser";
    return /Android/i.test(navigator.userAgent) ? "Android · Mint" : /iPhone|iPad/i.test(navigator.userAgent) ? "iPhone / iPad · Mint" : "Computer · Mint";
  }

  async function deliver(envelope: DeviceCommandEnvelope) {
    if (!device || stopped) return;
    if (envelope.deviceId !== device.id || seen.has(envelope.id) || envelope.sequence <= lastSequence) {
      throw new Error("Rejected a repeated or misdirected device command.");
    }
    seen.add(envelope.id);
    lastSequence = envelope.sequence;
    if (seen.size > 100) seen.delete(seen.values().next().value!);
    const remaining = Date.parse(envelope.expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("A device command expired before delivery.");
    const command = deviceCommandSchema.parse(envelope.command);
    const controller = new AbortController();
    executing = controller;
    const deadline = setTimeout(() => controller.abort(new Error("Device command expired.")), remaining);
    let success = false, error: string | undefined;
    try {
      if (command.action === "handoff") await options.applyHandoff(command.handoff, controller.signal);
      else await options.execute(command, controller.signal);
      controller.signal.throwIfAborted();
      const confirmed = state();
      if (command.action === "handoff") {
        const target = command.handoff;
        if (!confirmsHandoff(confirmed, target)) {
          throw new Error("Destination did not confirm the requested playback. Source will keep playing.");
        }
      }
      success = true;
    } catch (failure) {
      error = message(failure);
      report(failure);
    } finally { clearTimeout(deadline); executing = null; }
    if (!stopped) {
      await request(`/${device.id}/ack`, {
        token: device.token, id: envelope.id, sequence: envelope.sequence, success, error, state: state(),
      });
    }
  }

  async function tick() {
    if (stopped) return;
    const controller = new AbortController();
    inFlight = controller;
    try {
      if (!device) {
        const registration = await request<{ id: string; token: string }>("", { name: browserName(), state: state() }, controller.signal);
        device = registration;
        if (stopped) {
          await request(`/${registration.id}/revoke`, {}, undefined, true).catch(() => undefined);
          return;
        }
      }
      const snapshot = state(), queueIdentity = JSON.stringify(snapshot.queue);
      const { queue, ...playback } = snapshot;
      const result = await request<{ command: DeviceCommandEnvelope | null }>(`/${device.id}/poll`,
        { token: device.token, state: queueIdentity === lastQueue ? playback : { ...playback, queue } }, controller.signal);
      lastQueue = queueIdentity;
      if (result.command) await deliver(result.command);
      reported = "";
    } catch (error) {
      if (!stopped) {
        report(error);
        const status = (error as { status?: number }).status;
        // Revocation and expired sessions are intentional; never silently reconnect them.
        if (status === 401 || status === 403 || status === 404) { stopped = true; device = null; }
      }
    } finally {
      inFlight = null;
      if (!stopped) timer = setTimeout(tick, options.pollMs ?? 2000);
    }
  }

  const bridge: DeviceBridge = {
    get deviceId() { return device?.id ?? null; },
    dispose() {
      stopped = true;
      if (timer) clearTimeout(timer);
      inFlight?.abort();
      executing?.abort();
      if (activeBridge === bridge) activeBridge = null;
      if (device) void request(`/${device.id}/revoke`, {}, undefined, true).catch(() => undefined);
      device = null;
    },
    async handoffTo(destinationId: string) {
      if (!device || stopped) throw new Error("This browser is not connected yet. Try again shortly.");
      if (handoffBusy) throw new Error("A playback move is already in progress.");
      handoffBusy = true;
      const original = state();
      const identity = playbackIdentity(original);
      try {
        const admitted = await request<{ id: string; expiresAt: string }>(`/${device.id}/handoff`, {
          token: device.token, destinationId, state: original,
        });
        const deadline = Date.parse(admitted.expiresAt);
        while (!stopped && Date.now() <= deadline) {
          const result = await request<{ status: string; error?: string | null }>(`/commands/${admitted.id}`);
          if (result.status === "succeeded") {
            if (playbackIdentity(state()) !== identity) {
              throw new Error("Playback moved, but this tab changed tracks. Pause either device manually.");
            }
            if (original.playing) await options.execute({ action: "pause" });
            return;
          }
          if (result.status === "failed" || result.status === "expired") {
            throw new Error(result.error || "Playback could not move. This device will keep playing.");
          }
          await pause(500);
        }
        throw new Error("Destination did not confirm playback in time. This device will keep playing.");
      } finally { handoffBusy = false; }
    },
  };
  if (activeBridge) activeBridge.dispose();
  activeBridge = bridge;
  void tick();
  return bridge;
}
export const startBridge = startDeviceBridge;
