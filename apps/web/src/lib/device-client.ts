import {
  deviceCommandSchema, deviceStateSchema, confirmsHandoff,
  matchesDevicePlayback,
  type DeviceCommand, type DeviceCommandEnvelope, type DeviceHandoff, type DeviceState,
} from "@mint/core/devices";

type DeviceMemory = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type BridgeOptions = {
  memberId: string;
  getState: () => DeviceState;
  execute: (command: DeviceCommand, signal?: AbortSignal) => Promise<void>;
  applyHandoff: (handoff: DeviceHandoff, signal?: AbortSignal) => Promise<void>;
  error: (message: string) => void;
  fetcher?: typeof fetch;
  name?: string;
  pollMs?: number;
  /** Remembers this tab's device across refresh. Defaults to sessionStorage in the browser. */
  storage?: DeviceMemory | null;
};
function tabStore(): DeviceMemory | null {
  try { return typeof sessionStorage === "undefined" ? null : sessionStorage; }
  catch { return null; }
}
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
  let stopped = false, suspended = false, running = false, device: { id: string; token: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: AbortController | null = null;
  let executing: AbortController | null = null;
  let lastSequence = 0, handoffBusy = false, reported = "", lastQueue = "";
  const seen = new Set<string>();
  const storage = options.storage === undefined ? tabStore() : options.storage;
  const storageKey = `mint:device:${options.memberId}`;
  function disconnect(receiver: { id: string; token: string }) {
    if (storage?.getItem(storageKey) === receiver.id) storage.removeItem(storageKey);
    void request(`/${receiver.id}/disconnect`, { token: receiver.token }, undefined, true).catch((error) => {
      options.error(message(error));
    });
  }

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
  async function connect(): Promise<{ id: string; token: string }> {
    const saved = storage?.getItem(storageKey);
    if (saved) {
      try { return await request<{ id: string; token: string }>(`/${saved}/resume`, {}); }
      catch (error) {
        const status = (error as { status?: number }).status;
        if (status !== 404 && status !== 409) throw error;
        storage?.removeItem(storageKey);
      }
    }
    const created = request<{ id: string; token: string }>("", { name: browserName(), state: state() }).then((registration) => {
      storage?.setItem(storageKey, registration.id);
      return registration;
    });
    return created;
  }
  function browserName() {
    if (options.name) return options.name;
    return "Web player";
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
    if (command.action === "pause" && command.expected && !matchesDevicePlayback(state(), command.expected)) {
      await request(`/${device.id}/ack`, { token: device.token, id: envelope.id, sequence: envelope.sequence,
        success: false, error: "Source changed tracks during the move. Choose which device to pause.", state: state() });
      return;
    }
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
    if (stopped || suspended || running) return;
    running = true;
    const controller = new AbortController();
    inFlight = controller;
    try {
      if (!device) {
        device = await connect();
        if (stopped || suspended) { disconnect(device); device = null; return; }
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
        const status = (error as { status?: number }).status;
        // A signed-out session stays disconnected. A missing device is forgotten so the next
        // heartbeat can register once; a rejected token resumes the saved device instead.
        if (status === 401) { stopped = true; device = null; report(error); }
        else if (status === 404) { device = null; storage?.removeItem(storageKey); }
        else if (status === 403) device = null;
        else report(error);
      }
    } finally {
      inFlight = null;
      running = false;
      if (!stopped && !suspended) timer = setTimeout(tick, options.pollMs ?? 2000);
    }
  }

  const bridge: DeviceBridge = {
    get deviceId() { return device?.id ?? null; },
    dispose() {
      stopped = true;
      if (timer) clearTimeout(timer);
      inFlight?.abort();
      executing?.abort();
      if (typeof window !== "undefined") {
        window.removeEventListener("pagehide", pageHide);
        window.removeEventListener("pageshow", pageShow);
      }
      if (activeBridge === bridge) activeBridge = null;
      if (device) disconnect(device);
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
        while (!stopped && !suspended && Date.now() <= deadline) {
          const result = await request<{ status: string; error?: string | null }>(`/commands/${admitted.id}`);
          if (stopped || suspended) throw new Error("This player disconnected during the move.");
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
  function pageHide() {
    suspended = true;
    if (timer) clearTimeout(timer);
    inFlight?.abort(); executing?.abort();
    if (device) disconnect(device);
    device = null;
  }
  function pageShow(event: PageTransitionEvent) {
    if (event.persisted && !stopped) { suspended = false; lastQueue = ""; void tick(); }
  }
  if (activeBridge) activeBridge.dispose();
  activeBridge = bridge;
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", pageHide);
    window.addEventListener("pageshow", pageShow);
  }
  void tick();
  return bridge;
}
export const startBridge = startDeviceBridge;

export type ConnectableDevice = {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: string;
  state: { playing: boolean; queueLength: number; volume: number; trackId: string | null };
};

async function deviceRequest<T>(path: string, value?: unknown): Promise<T> {
  const response = await fetch(`/api/devices${path}`, {
    method: value === undefined ? "GET" : "POST", cache: "no-store", credentials: "same-origin",
    ...(value === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(value) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "Device service did not respond.");
  return result as T;
}

export function playbackSource<T extends { id: string; online: boolean; lastSeenAt: string; state: { playing: boolean; queueLength: number } }>(devices: T[], destinationId: string) {
  const ready = devices.filter((device) => device.online && device.state.queueLength > 0);
  const playing = ready.find((device) => device.state.playing);
  if (playing) return playing.id === destinationId ? null : playing;
  return [...ready].filter((device) => device.id !== destinationId).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0] ?? null;
}

export function activeOutput<T extends { online: boolean; lastSeenAt: string; state: { playing: boolean; queueLength: number } }>(devices: T[]) {
  return [...devices].filter((device) => device.online && device.state.playing && device.state.queueLength > 0)
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0] ?? null;
}

async function waitForCommand(id: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() <= deadline) {
    const result = await deviceRequest<{ status: string; error?: string | null }>(`/commands/${id}`);
    if (result.status === "succeeded") return;
    if (result.status === "failed" || result.status === "expired") throw new Error(result.error || "The other device did not start playback.");
    await pause(500);
  }
  throw new Error("The other device did not confirm playback in time.");
}

export function listConnectableDevices() {
  return deviceRequest<ConnectableDevice[]>("");
}

/** Make one signed-in device the output, pulling playback from whichever device currently has it. */
export async function connectToDevice(destinationId: string) {
  const localId = getLocalDeviceId();
  if (!localId) throw new Error("This browser is not connected yet. Try again shortly.");
  const devices = await listConnectableDevices();
  const destination = devices.find((device) => device.id === destinationId);
  if (!destination?.online) throw new Error("That device is asleep. Open Mint there and try again.");
  const source = playbackSource(devices, destinationId);
  if (!source) {
    if (!destination.state.queueLength) throw new Error("Play a song on one device before moving it.");
    return;
  }
  if (source.id === localId) {
    await handoffToDevice(destinationId);
    return;
  }
  const admitted = await deviceRequest<{ id: string; sourceId: string }>("/transfer", { destinationId });
  await waitForCommand(admitted.id);
  const paused = await deviceRequest<{ id: string }>("/complete-transfer", { commandId: admitted.id });
  await waitForCommand(paused.id);
}

let previewAt = 0;
let previewSeconds = 0;
/** Tell every signed-in device where the playhead is while someone is dragging it. */
export function previewDevicePosition(deviceId: string, seconds: number | null) {
  if (seconds === null) {
    void deviceRequest(`/${deviceId}/position`, { time: previewSeconds, scrubbing: false }).catch(() => undefined);
    return;
  }
  previewSeconds = seconds;
  const now = Date.now();
  if (now - previewAt < 80) return;
  previewAt = now;
  void deviceRequest(`/${deviceId}/position`, { time: seconds, scrubbing: true }).catch(() => undefined);
}

export async function controlDevice(deviceId: string, action: "play" | "pause" | "next" | "previous" | "seek" | "volume", value?: number) {
  const admitted = await deviceRequest<{ id: string }>(`/${deviceId}/commands`, value === undefined ? { action } : { action, value });
  await waitForCommand(admitted.id);
}

export async function setRemoteVolume(deviceId: string, value: number) {
  const admitted = await deviceRequest<{ id: string }>(`/${deviceId}/commands`, { action: "volume", value });
  await waitForCommand(admitted.id);
}
