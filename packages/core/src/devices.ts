import { z } from "zod";
import { deviceStateSchema, deviceQueueSchema } from "@mint/client/devices";
export {
  deviceQueueSchema, deviceQueueContextSchema, deviceHeartbeatSchema, deviceStateSchema,
  handoffSchema, confirmsHandoff, deviceCommandSchema,
  devicePlaybackIdentity, matchesDevicePlayback,
  type DeviceState, type DeviceHandoff, type DeviceCommand, type DeviceCommandEnvelope,
} from "@mint/client/devices";

export const DEVICE_ONLINE_MS = 25_000;
export const NATIVE_DEVICE_RETENTION_MS = 30 * 24 * 3600_000;
export const DEVICE_COMMAND_TTL_MS = 20_000;
export const PARTY_TTL_MS = 12 * 60 * 60_000;
export const registerDeviceSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["web", "native"]).optional(),
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
export type DeviceActor = { userId: string; sessionId: string; installationId?: string; deviceName?: string };
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
