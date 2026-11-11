import { z } from "zod";

export const deviceQueueContextSchema = z.object({
  id: z.uuid(), total: z.number().int().nonnegative(), revision: z.number().int().positive(),
  offset: z.number().int().nonnegative(), position: z.number().int().nonnegative(), shuffle: z.boolean(),
});
export const deviceQueueSchema = z.array(z.uuid()).max(50_000);
const fields = {
  playing: z.boolean(), time: z.number().finite().min(0).max(7 * 86400),
  duration: z.number().finite().min(0).max(7 * 86400), volume: z.number().finite().min(0).max(100),
  trackId: z.uuid().nullable(), currentIndex: z.number().int().min(0).max(49_999),
  shuffle: z.boolean(), repeat: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  queueContext: deviceQueueContextSchema.nullish(), queueEntryIds: z.array(z.uuid()).max(100).nullish(),
};
export const deviceHeartbeatSchema = z.object({ ...fields, queue: deviceQueueSchema.optional() });
export const deviceStateSchema = z.object({ ...fields, queue: deviceQueueSchema }).superRefine((state, ctx) => {
  if ((state.queue.length && state.currentIndex >= state.queue.length) || state.trackId !== (state.queue[state.currentIndex] ?? null)) {
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
  queue: deviceQueueSchema.min(1), currentIndex: z.number().int().min(0).max(49_999),
  position: z.number().finite().min(0).max(7 * 86400), playing: z.boolean(), shuffle: z.boolean(),
  repeat: fields.repeat, queueContext: deviceQueueContextSchema.nullish(),
}).refine((value) => value.currentIndex < value.queue.length, "Current track is outside the queue");
export type DeviceHandoff = z.infer<typeof handoffSchema>;
export const devicePlaybackIdentitySchema = z.object({
  trackId: fields.trackId, index: z.number().int().nonnegative(),
  contextId: z.uuid().nullable(), revision: z.number().int().positive().nullable(),
});
export function devicePlaybackIdentity(state: DeviceState) {
  return { trackId: state.trackId, index: state.queueContext?.position ?? state.currentIndex,
    contextId: state.queueContext?.id ?? null, revision: state.queueContext?.revision ?? null };
}
export function matchesDevicePlayback(state: DeviceState, expected: z.infer<typeof devicePlaybackIdentitySchema>) {
  return JSON.stringify(devicePlaybackIdentity(state)) === JSON.stringify(expected);
}
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
  z.object({ action: z.literal("pause"), expected: devicePlaybackIdentitySchema.optional() }),
  z.object({ action: z.literal("next") }),
  z.object({ action: z.literal("previous") }),
  z.object({ action: z.literal("clear") }),
  z.object({ action: z.literal("seek"), value: fields.time }),
  z.object({ action: z.literal("volume"), value: fields.volume }),
  z.object({ action: z.literal("queue"), trackIds: deviceQueueSchema, currentIndex: fields.currentIndex })
    .refine((value) => !value.trackIds.length || value.currentIndex < value.trackIds.length, "Invalid queue index"),
  z.object({ action: z.literal("handoff"), handoff: handoffSchema }),
  z.object({ action: z.literal("queue-edit"), edit: z.discriminatedUnion("action", [
    z.object({ action: z.literal("remove"), entryId: z.uuid() }),
    z.object({ action: z.literal("move"), entryId: z.uuid(), before: z.uuid() }),
    z.object({ action: z.literal("append"), trackId: z.uuid() }),
  ]) }),
]);
export type DeviceCommand = z.infer<typeof deviceCommandSchema>;
export const deviceEnvelopeSchema = z.object({
  id: z.uuid(), deviceId: z.uuid(), sequence: z.number().int().positive(),
  expiresAt: z.iso.datetime(), command: deviceCommandSchema,
});
export type DeviceCommandEnvelope = z.infer<typeof deviceEnvelopeSchema>;
export const connectableDeviceSchema = z.object({
  id: z.uuid(), name: z.string(), kind: z.enum(["web", "native"]),
  online: z.boolean(), lastSeenAt: z.iso.datetime(),
  state: z.object({ playing: z.boolean(), queueLength: z.number().int().nonnegative(), volume: fields.volume, trackId: fields.trackId }),
});
export type ConnectableDevice = z.infer<typeof connectableDeviceSchema>;
export const deviceRegistrationSchema = z.object({ id: z.uuid(), token: z.string() });
export const deviceCommandStatusSchema = z.object({
  id: z.uuid(), status: z.enum(["pending", "delivered", "succeeded", "failed", "expired"]),
  error: z.string().nullish(), expiresAt: z.iso.datetime(),
});
