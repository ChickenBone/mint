import { ApiError, confirmsHandoff, deviceEnvelopeSchema, deviceStateSchema, matchesDevicePlayback, playbackSource, type DeviceCommand, type DeviceHandoff, type DeviceState, type MintApi } from "@mint/client";

type Options = {
  api: Pick<MintApi, "registerDevice" | "pollDevice" | "acknowledgeDevice" | "disconnectDevice" | "handoffDevice" | "deviceCommandStatus">;
  state(): DeviceState;
  execute(command: DeviceCommand, signal?: AbortSignal): Promise<void>;
  apply(handoff: DeviceHandoff, signal: AbortSignal): Promise<void>;
  error(message: string | null): void;
  pollMs?: number;
  kind?: "web" | "native";
};
export type NativeDeviceBridge = { readonly deviceId: string | null; dispose(): void; sleep(): void; wake(): void; handoffTo(id: string): Promise<void> };
const message = (error: unknown) => error instanceof Error ? error.message : "Device connection failed.";
const identity = (state: DeviceState) => JSON.stringify([state.trackId, state.queueContext ?? state.queue, state.currentIndex, state.playing]);

export async function movePlaybackToDevice(
  destinationId: string,
  api: Pick<MintApi, "devices" | "transferDevice" | "completeDeviceTransfer" | "deviceCommandStatus">,
  bridge: Pick<NativeDeviceBridge, "deviceId" | "handoffTo">,
  isCurrent: () => boolean,
) {
  const requireCurrent = () => { if (!isCurrent()) throw new Error("Account changed during the playback move."); };
  const rows = await api.devices();
  requireCurrent();
  const destination = rows.find((row) => row.id === destinationId);
  if (!destination?.online) throw new Error("That device is asleep. Open Mint there and try again.");
  const source = playbackSource(rows, destinationId);
  if (!source) {
    if (!destination.state.queueLength) throw new Error("Play a song on one device before moving it.");
    return;
  }
  if (source.id === bridge.deviceId) {
    await bridge.handoffTo(destinationId);
    return;
  }
  const wait = async (commandId: string) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      requireCurrent();
      const command = await api.deviceCommandStatus(commandId);
      if (command.status === "succeeded") return;
      if (command.status === "failed" || command.status === "expired") throw new Error(command.error || "Playback move was not confirmed.");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Device did not confirm the playback move.");
  };
  const transferred = await api.transferDevice(destinationId);
  await wait(transferred.id);
  requireCurrent();
  const pause = await api.completeDeviceTransfer(transferred.id);
  await wait(pause.id);
}

export function startNativeDeviceBridge(options: Options): NativeDeviceBridge {
  let stopped = false, suspended = false, running = false, busy = false;
  let receiver: { id: string; token: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let executing: AbortController | null = null;
  const lifetime = new AbortController();
  const seen = new Set<string>();
  let sequence = 0;
  const state = () => deviceStateSchema.parse(options.state());
  async function network<T>(request: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController();
    const abort = () => controller.abort(lifetime.signal.reason);
    if (lifetime.signal.aborted) abort();
    else lifetime.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error("Device service did not respond. Check the connection and retry.")), 10_000);
    try { return await request(controller.signal); }
    finally { clearTimeout(timeout); lifetime.signal.removeEventListener("abort", abort); }
  }
  async function disconnect(value: NonNullable<typeof receiver>) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try { await options.api.disconnectDevice(value.id, value.token, controller.signal); }
    catch (error) { if (!(error instanceof ApiError && (error.status === 401 || error.status === 404))) options.error(message(error)); }
    finally { clearTimeout(timeout); }
  }
  async function tick() {
    if (stopped || suspended || running) return;
    running = true;
    try {
      if (!receiver) {
        receiver = await network((signal) => options.api.registerDevice(state(), signal, options.kind));
        sequence = 0; seen.clear();
        if (stopped || suspended) { await disconnect(receiver); receiver = null; return; }
      }
      const current = receiver;
      const result = await network((signal) => options.api.pollDevice(current.id, current.token, state(), signal));
      if (stopped || suspended || !receiver) return;
      if (result.command) {
        const envelope = deviceEnvelopeSchema.parse(result.command);
        if (envelope.deviceId !== receiver.id || envelope.sequence <= sequence || seen.has(envelope.id)) throw new Error("Rejected a repeated or misdirected device command.");
        const remaining = Date.parse(envelope.expiresAt) - Date.now();
        if (remaining <= 0) throw new Error("Device command expired before delivery.");
        sequence = envelope.sequence; seen.add(envelope.id);
        if (seen.size > 100) seen.delete(seen.values().next().value!);
        const controller = new AbortController();
        executing = controller;
        const deadline = setTimeout(() => controller.abort(new Error("Device command expired.")), remaining);
        let error: string | undefined;
        try {
          if (envelope.command.action === "pause" && envelope.command.expected && !matchesDevicePlayback(state(), envelope.command.expected)) {
            throw new Error("Source changed tracks during the move. Choose which device to pause.");
          }
          if (envelope.command.action === "handoff") {
            await options.apply(envelope.command.handoff, controller.signal);
            if (!confirmsHandoff(state(), envelope.command.handoff)) throw new Error("Destination did not confirm playback.");
          } else await options.execute(envelope.command, controller.signal);
          controller.signal.throwIfAborted();
        } catch (failure) { error = message(failure); options.error(error); }
        finally { clearTimeout(deadline); executing = null; }
        if (!stopped && !suspended && receiver) await network((signal) => options.api.acknowledgeDevice(current.id, {
          token: current.token, id: envelope.id, sequence: envelope.sequence, success: !error, error, state: state(),
        }, signal));
      } else options.error(null);
    } catch (error) {
      if (!stopped) {
        options.error(message(error));
        if (error instanceof ApiError && error.status === 401) stopped = true;
        else if (error instanceof ApiError && [403, 404].includes(error.status)) receiver = null;
      }
    } finally {
      running = false;
      if (!stopped && !suspended) timer = setTimeout(tick, options.pollMs ?? 2000);
    }
  }
  const bridge: NativeDeviceBridge = {
    get deviceId() { return receiver?.id ?? null; },
    wake() { suspended = false; if (timer) clearTimeout(timer); void tick(); },
    sleep() {
      suspended = true;
      if (timer) clearTimeout(timer);
      executing?.abort();
      if (receiver) void disconnect(receiver);
      receiver = null;
    },
    dispose() {
      stopped = true; lifetime.abort(); executing?.abort();
      if (timer) clearTimeout(timer);
      if (receiver) void disconnect(receiver);
      receiver = null;
    },
    async handoffTo(destinationId) {
      if (!receiver || stopped || suspended) throw new Error("This player is not connected yet. Retry after reconnecting.");
      if (busy) throw new Error("A playback move is already in progress.");
      busy = true;
      const original = state(), originalIdentity = identity(original), current = receiver;
      try {
        const admitted = await network((signal) => options.api.handoffDevice(current.id, current.token, destinationId, original, signal));
        while (!stopped && !suspended && Date.now() < Date.parse(admitted.expiresAt)) {
          const status = await network((signal) => options.api.deviceCommandStatus(admitted.id, signal));
          if (stopped || suspended) throw new Error("This player disconnected during the move.");
          if (status.status === "succeeded") {
            if (identity(state()) !== originalIdentity) throw new Error("Playback moved but this player changed tracks. Choose which device to pause.");
            if (original.playing) await options.execute({ action: "pause" });
            return;
          }
          if (status.status === "failed" || status.status === "expired") throw new Error(status.error || "Playback could not move. This player will keep playing.");
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        throw new Error("Destination did not confirm playback. This player will keep playing.");
      } finally { busy = false; }
    },
  };
  void tick();
  return bridge;
}
