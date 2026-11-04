import { z } from "zod";

export const DEVICE_ONLINE_MS = 25_000;
export const DEVICE_COMMAND_TTL_MS = 20_000;
export const PARTY_TTL_MS = 12 * 60 * 60_000;
export const deviceQueueSchema = z.array(z.uuid()).max(50_000);
export const deviceQueueContextSchema = z.object({
  id: z.uuid(), total: z.number().int().nonnegative(), revision: z.number().int().positive(),
  offset: z.number().int().nonnegative(), position: z.number().int().nonnegative(), shuffle: z.boolean(),
});
const deviceStateFields = {
  playing: z.boolean(),
  time: z.number().finite().min(0).max(7 * 86400),
  duration: z.number().finite().min(0).max(7 * 86400),
  volume: z.number().finite().min(0).max(100),
  trackId: z.uuid().nullable(),
  currentIndex: z.number().int().min(0).max(49_999),
  shuffle: z.boolean(),
  repeat: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  queueContext: deviceQueueContextSchema.nullish(),
  queueEntryIds: z.array(z.uuid()).max(100).nullish(),
};
export const deviceHeartbeatSchema = z.object({ ...deviceStateFields, queue: deviceQueueSchema.optional() });
export const deviceStateSchema = z.object({ ...deviceStateFields, queue: deviceQueueSchema }).superRefine((state, ctx) => {
  if (state.queue.length && state.currentIndex >= state.queue.length) {
    ctx.addIssue({ code: "custom", message: "Current track is outside the queue" });
  }
  if (state.trackId !== (state.queue[state.currentIndex] ?? null)) {
    ctx.addIssue({ code: "custom", message: "Current track does not match the queue" });
  }
  if (state.queueContext && (state.queueContext.position !== state.queueContext.offset + state.currentIndex ||
      state.queueContext.offset + state.queue.length > state.queueContext.total || state.queueContext.shuffle !== state.shuffle ||
      state.queueEntryIds?.length !== state.queue.length || new Set(state.queueEntryIds).size !== state.queue.length)) {
    ctx.addIssue({ code: "custom", message: "Progressive queue window is inconsistent" });
  }
});
export type DeviceState = z.infer<typeof deviceStateSchema>;
export const handoffSchema = z.object({
  queue: deviceQueueSchema.min(1),
  currentIndex: z.number().int().min(0).max(49_999),
  position: z.number().finite().min(0).max(7 * 86400),
  playing: z.boolean(),
  shuffle: z.boolean(),
  repeat: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  queueContext: deviceQueueContextSchema.nullish(),
}).refine((value) => value.currentIndex < value.queue.length, "Current track is outside the queue");
export type DeviceHandoff = z.infer<typeof handoffSchema>;
export function confirmsHandoff(state: DeviceState, target: DeviceHandoff) {
  const queueMatches = target.queueContext
    ? state.queueContext?.id === target.queueContext.id && state.queueContext.revision === target.queueContext.revision &&
      state.queueContext.position === target.queueContext.position
    : !state.queueContext && state.currentIndex === target.currentIndex && JSON.stringify(state.queue) === JSON.stringify(target.queue);
  return queueMatches && state.playing === target.playing && state.trackId === target.queue[target.currentIndex] &&
    Math.abs(state.time - target.position) <= 5 && state.shuffle === target.shuffle && state.repeat === target.repeat;
}
export const deviceCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("play") }),
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("next") }),
  z.object({ action: z.literal("previous") }),
  z.object({ action: z.literal("clear") }),
  z.object({ action: z.literal("seek"), value: z.number().finite().min(0).max(7 * 86400) }),
  z.object({ action: z.literal("volume"), value: z.number().finite().min(0).max(100) }),
  z.object({ action: z.literal("queue"), trackIds: deviceQueueSchema, currentIndex: z.number().int().min(0).max(49_999) })
    .refine((value) => !value.trackIds.length || value.currentIndex < value.trackIds.length, "Invalid queue index"),
  z.object({ action: z.literal("handoff"), handoff: handoffSchema }),
  z.object({ action: z.literal("queue-edit"), edit: z.discriminatedUnion("action", [
    z.object({ action: z.literal("remove"), entryId: z.uuid() }),
    z.object({ action: z.literal("move"), entryId: z.uuid(), before: z.uuid() }),
    z.object({ action: z.literal("append"), trackId: z.uuid() }),
  ]) }),
]);
export type DeviceCommand = z.infer<typeof deviceCommandSchema>;
export type DeviceCommandEnvelope = {
  id: string;
  deviceId: string;
  sequence: number;
  expiresAt: string;
  command: DeviceCommand;
};
export const registerDeviceSchema = z.object({
  name: z.string().trim().min(1).max(80),
  state: deviceStateSchema,
});
export const deviceAckSchema = z.object({
  id: z.uuid(), sequence: z.number().int().positive(),
  success: z.boolean(), error: z.string().max(500).optional(),
  state: deviceStateSchema,
});
export const partyQueueSchema = z.object({
  revision: z.number().int().nonnegative(),
  queue: deviceQueueSchema,
});
export type DeviceActor = { userId: string; sessionId: string };
export class DeviceError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function assertDeviceOnline(device: { lastSeenAt: Date; revokedAt: Date | null }, now = Date.now()) {
  if (device.revokedAt || now - device.lastSeenAt.getTime() > DEVICE_ONLINE_MS) {
    throw new DeviceError(409, "Device is asleep or disconnected. Open Mint on that device first.");
  }
}
export function assertCommandClaimable(command: { status: string; expiresAt: Date }, now = Date.now()) {
  if (command.status !== "pending" || command.expiresAt.getTime() <= now) {
    throw new DeviceError(409, "Command has expired or was already delivered.");
  }
}
export function assertPartyEditor(party: { hostId: string; guestsCanEdit: boolean }, userId: string, participant: boolean) {
  if (party.hostId !== userId && (!participant || !party.guestsCanEdit)) {
    throw new DeviceError(403, "Only the host can edit this queue.");
  }
}
export function assertPartyRevision(current: number, supplied: number) {
  if (current !== supplied) throw new DeviceError(409, "The party queue changed. Refresh before editing.");
}
