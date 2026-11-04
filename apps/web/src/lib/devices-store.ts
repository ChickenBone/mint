import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@mint/core/db";
import { sessions, tracks, users } from "@mint/core/schema";
import { PLAYABLE } from "@mint/core/playback";
import { playbackQueues, playbackQueueEntries } from "@mint/core/playback-queues-db";
import { connectedDevices as devices, deviceCommands as commands, partyParticipants as participants, partySessions as parties } from "@mint/core/devices-db";
import {
  DEVICE_COMMAND_TTL_MS, DEVICE_ONLINE_MS, PARTY_TTL_MS, DeviceError,
  assertCommandClaimable, assertDeviceOnline, assertPartyEditor, assertPartyRevision, confirmsHandoff,
  deviceAckSchema, deviceCommandSchema, deviceHeartbeatSchema, deviceQueueSchema, deviceStateSchema, registerDeviceSchema,
  type DeviceActor, type DeviceCommand,
} from "@mint/core/devices";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Device = typeof devices.$inferSelect;
type Party = typeof parties.$inferSelect;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const publicDevice = (device: Device, now: number) => {
  const { queue, ...state } = device.state;
  return {
    id: device.id, name: device.name, state: { ...state, queueLength: state.queueContext?.total ?? queue.length },
    online: !device.revokedAt && now - device.lastSeenAt.getTime() <= DEVICE_ONLINE_MS,
    lastSeenAt: device.lastSeenAt.toISOString(),
  };
};
const publicCommand = (command: typeof commands.$inferSelect) => ({
  id: command.id, deviceId: command.deviceId, sequence: command.sequence,
  command: command.command, status: command.status,
  error: command.error, expiresAt: command.expiresAt.toISOString(),
});

/** Every operation revalidates the authenticated session, including previously queued commands. */
export class DeviceStore {
  constructor(private db: Db, private actor: DeviceActor, private clock: () => number = Date.now) {}

  private async run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const [session] = await tx.select({ id: sessions.id }).from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(and(eq(sessions.id, this.actor.sessionId), eq(sessions.userId, this.actor.userId),
          gt(sessions.expiresAt, new Date(this.clock())), eq(users.status, "active")));
      if (!session) throw new DeviceError(401, "Your session expired. Sign in again.");
      return fn(tx);
    });
  }

  private async owned(tx: Tx, id: string, receiverToken?: string) {
    const [device] = await tx.select().from(devices)
      .where(and(eq(devices.id, id), eq(devices.userId, this.actor.userId), isNull(devices.revokedAt))).for("update");
    if (!device) throw new DeviceError(404, "Device not found.");
    if (receiverToken !== undefined) {
      const supplied = Buffer.from(hash(receiverToken));
      const expected = Buffer.from(device.tokenHash);
      if (device.authSessionId !== this.actor.sessionId || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        throw new DeviceError(403, "This device belongs to another browser session.");
      }
    } else {
      const [session] = await tx.select({ id: sessions.id }).from(sessions)
        .where(and(eq(sessions.id, device.authSessionId), gt(sessions.expiresAt, new Date(this.clock()))));
      if (!session) throw new DeviceError(409, "Device session expired. Reopen Mint on that device.");
    }
    return device;
  }

  private async readyTracks(tx: Tx, ids: string[]) {
    const unique = [...new Set(deviceQueueSchema.parse(ids))];
    if (!unique.length) return;
    const available = await tx.select({ id: tracks.id }).from(tracks)
      .where(and(inArray(tracks.id, unique), PLAYABLE));
    if (available.length !== unique.length) throw new DeviceError(400, "The queue contains tracks that are not available in Mint.");
  }

  private async enqueue(tx: Tx, device: Device, command: DeviceCommand) {
    assertDeviceOnline(device, this.clock());
    const parsed = deviceCommandSchema.parse(command);
    if (parsed.action === "queue") await this.readyTracks(tx, parsed.trackIds);
    if (parsed.action === "handoff") await this.readyTracks(tx, parsed.handoff.queue);
    const [stats] = await tx.select({ count: sql<number>`count(*)::int` }).from(commands)
      .where(and(eq(commands.deviceId, device.id), inArray(commands.status, ["pending", "delivered"]),
        gt(commands.expiresAt, new Date(this.clock()))));
    if ((stats?.count ?? 0) >= 8) throw new DeviceError(429, "This device is busy. Wait for its current commands.");
    const [updated] = await tx.update(devices).set({ sequence: sql`${devices.sequence} + 1` })
      .where(eq(devices.id, device.id)).returning();
    if (!updated) throw new DeviceError(409, "Device disconnected.");
    const [commandRow] = await tx.insert(commands).values({
      deviceId: device.id, actorId: this.actor.userId, actorSessionId: this.actor.sessionId,
      sequence: updated.sequence, command: parsed, expiresAt: new Date(this.clock() + DEVICE_COMMAND_TTL_MS),
    }).returning();
    if (!commandRow) throw new Error("Command was not stored");
    return publicCommand(commandRow);
  }

  async list() {
    return this.run(async (tx) => {
      const rows = await tx.select().from(devices)
        .innerJoin(sessions, eq(sessions.id, devices.authSessionId))
        .where(and(eq(devices.userId, this.actor.userId), isNull(devices.revokedAt), gt(sessions.expiresAt, new Date(this.clock()))))
        .orderBy(desc(devices.lastSeenAt)).limit(30);
      return rows.map((row) => publicDevice(row.connected_devices, this.clock()));
    });
  }

  async getDevice(id: string) {
    return this.run(async (tx) => {
      const device = await this.owned(tx, id);
      return { ...publicDevice(device, this.clock()), state: device.state };
    });
  }

  async register(input: unknown) {
    const data = registerDeviceSchema.parse(input);
    return this.run(async (tx) => {
      // Serializes registration limits across tabs on the same account.
      await tx.select({ id: users.id }).from(users).where(eq(users.id, this.actor.userId)).for("update");
      await tx.delete(devices).where(and(eq(devices.userId, this.actor.userId),
        or(lt(devices.lastSeenAt, new Date(this.clock() - 24 * 3600_000)), lt(devices.revokedAt, new Date(this.clock())))));
      const [stats] = await tx.select({ count: sql<number>`count(*)::int` }).from(devices)
        .where(and(eq(devices.userId, this.actor.userId), isNull(devices.revokedAt)));
      if ((stats?.count ?? 0) >= 30) throw new DeviceError(429, "Remove an old device before connecting another.");
      const secret = token();
      const [device] = await tx.insert(devices).values({
        userId: this.actor.userId, authSessionId: this.actor.sessionId, tokenHash: hash(secret),
        name: data.name, state: data.state, lastSeenAt: new Date(this.clock()),
      }).returning();
      if (!device) throw new Error("Device was not stored");
      return { ...publicDevice(device, this.clock()), token: secret };
    });
  }

  async rename(id: string, name: string) {
    const parsed = registerDeviceSchema.shape.name.parse(name);
    return this.run(async (tx) => {
      await this.owned(tx, id);
      await tx.update(devices).set({ name: parsed }).where(eq(devices.id, id));
      return { ok: true };
    });
  }

  async revoke(id: string) {
    return this.run(async (tx) => {
      await this.owned(tx, id);
      await tx.update(devices).set({ revokedAt: new Date(this.clock()) }).where(eq(devices.id, id));
      await tx.update(commands).set({ status: "failed", error: "Device disconnected." })
        .where(and(eq(commands.deviceId, id), inArray(commands.status, ["pending", "delivered"])));
      await tx.update(parties).set({ closedAt: new Date(this.clock()), inviteHash: null }).where(eq(parties.deviceId, id));
      return { ok: true };
    });
  }

  async poll(id: string, receiverToken: string, state: unknown) {
    const heartbeat = deviceHeartbeatSchema.parse(state);
    return this.run(async (tx) => {
      const current = await this.owned(tx, id, receiverToken);
      const parsed = deviceStateSchema.parse({ ...heartbeat, queue: heartbeat.queue ?? current.state.queue });
      await tx.delete(commands).where(and(eq(commands.deviceId, id), lt(commands.createdAt, new Date(this.clock() - 24 * 3600_000))));
      await tx.update(devices).set({ state: parsed, lastSeenAt: new Date(this.clock()) }).where(eq(devices.id, id));
      await tx.update(commands).set({ status: "expired", error: "Device did not acknowledge before the deadline." })
        .where(and(eq(commands.deviceId, id), inArray(commands.status, ["pending", "delivered"]),
          lt(commands.expiresAt, new Date(this.clock()))));
      const [inFlight] = await tx.select({ id: commands.id }).from(commands)
        .where(and(eq(commands.deviceId, id), eq(commands.status, "delivered"),
          gt(commands.expiresAt, new Date(this.clock())))).limit(1);
      if (inFlight) return { command: null };
      // Delivery is terminal: no lease retry can execute a command twice.
      const [candidate] = await tx.select({ command: commands, sessionExpires: sessions.expiresAt, status: users.status })
        .from(commands).innerJoin(sessions, eq(commands.actorSessionId, sessions.id))
        .innerJoin(users, eq(commands.actorId, users.id))
        .where(and(eq(commands.deviceId, id), eq(commands.status, "pending"), gt(commands.expiresAt, new Date(this.clock()))))
        .orderBy(commands.sequence).limit(1);
      if (!candidate) return { command: null };
      assertCommandClaimable(candidate.command, this.clock());
      if (candidate.sessionExpires.getTime() <= this.clock() || candidate.status !== "active") {
        await tx.update(commands).set({ status: "failed", error: "Controller session expired." }).where(eq(commands.id, candidate.command.id));
        return { command: null };
      }
      const [claimed] = await tx.update(commands).set({ status: "delivered", deliveredAt: new Date(this.clock()) })
        .where(and(eq(commands.id, candidate.command.id), eq(commands.status, "pending"))).returning();
      return { command: claimed ? publicCommand(claimed) : null };
    });
  }

  async acknowledge(id: string, receiverToken: string, input: unknown) {
    const ack = deviceAckSchema.parse(input);
    return this.run(async (tx) => {
      await this.owned(tx, id, receiverToken);
      const [command] = await tx.select().from(commands)
        .where(and(eq(commands.id, ack.id), eq(commands.deviceId, id), eq(commands.sequence, ack.sequence))).for("update");
      if (!command || command.status !== "delivered" || command.expiresAt.getTime() <= this.clock()) {
        throw new DeviceError(409, "Acknowledgment expired or was already accepted.");
      }
      if (ack.success && command.command.action === "handoff") {
        const handoff = command.command.handoff;
        if (!confirmsHandoff(ack.state, handoff)) {
          throw new DeviceError(409, "Destination did not confirm the requested playback.");
        }
      }
      if (ack.success && command.command.action === "queue" &&
          (JSON.stringify(ack.state.queue) !== JSON.stringify(command.command.trackIds) ||
           (ack.state.queue.length > 0 && ack.state.currentIndex !== command.command.currentIndex))) {
        throw new DeviceError(409, "Device did not confirm the requested queue.");
      }
      await tx.update(commands).set({
        status: ack.success ? "succeeded" : "failed", acknowledgedAt: new Date(this.clock()),
        error: ack.success ? null : (ack.error || "Playback was blocked. Open Mint and start playback on the destination."),
      }).where(eq(commands.id, command.id));
      await tx.update(devices).set({ state: ack.state, lastSeenAt: new Date(this.clock()) }).where(eq(devices.id, id));
      return { ok: true };
    });
  }

  async command(id: string, input: unknown) {
    const parsed = deviceCommandSchema.parse(input);
    if (parsed.action === "handoff") throw new DeviceError(400, "Use the explicit handoff action.");
    return this.run(async (tx) => this.enqueue(tx, await this.owned(tx, id), parsed));
  }

  async handoff(sourceId: string, sourceToken: string, destinationId: string, state: unknown) {
    const parsed = deviceStateSchema.parse(state);
    if (sourceId === destinationId) throw new DeviceError(400, "Choose another device.");
    return this.run(async (tx) => {
      // Stable lock order also covers two browsers moving playback in opposite directions.
      const ids = [sourceId, destinationId].sort();
      for (const id of ids) await this.owned(tx, id, id === sourceId ? sourceToken : undefined);
      if (!parsed.queue.length) throw new DeviceError(400, "Start a track before moving playback.");
      const source = await this.owned(tx, sourceId, sourceToken);
      assertDeviceOnline(source, this.clock());
      const party = await tx.select({ id: parties.id }).from(parties)
        .where(and(inArray(parties.deviceId, [sourceId, destinationId]), isNull(parties.closedAt), gt(parties.expiresAt, new Date(this.clock())))).limit(1);
      if (party.length) throw new DeviceError(409, "End the party before moving its playback device.");
      return this.enqueue(tx, await this.owned(tx, destinationId), {
        action: "handoff", handoff: {
          queue: parsed.queue, currentIndex: parsed.currentIndex, position: parsed.time,
          playing: parsed.playing, shuffle: parsed.shuffle, repeat: parsed.repeat,
          queueContext: parsed.queueContext,
        },
      });
    });
  }

  async commandStatus(id: string) {
    return this.run(async (tx) => {
      const [command] = await tx.select().from(commands)
        .where(and(eq(commands.id, id), eq(commands.actorId, this.actor.userId), eq(commands.actorSessionId, this.actor.sessionId)));
      if (!command) throw new DeviceError(404, "Command not found.");
      if (["pending", "delivered"].includes(command.status) && command.expiresAt.getTime() <= this.clock()) {
        await tx.update(commands).set({ status: "expired", error: "Device did not confirm the command." }).where(eq(commands.id, id));
        return { ...publicCommand(command), status: "expired", error: "Device did not confirm the command." };
      }
      return publicCommand(command);
    });
  }

  private async party(tx: Tx, id: string, hostOnly = false) {
    const [party] = await tx.select().from(parties).where(eq(parties.id, id)).for("update");
    if (!party || party.closedAt || party.expiresAt.getTime() <= this.clock()) throw new DeviceError(404, "Party ended or expired.");
    const [member] = await tx.select({ id: participants.id }).from(participants)
      .where(and(eq(participants.partyId, id), eq(participants.userId, this.actor.userId)));
    if (party.hostId !== this.actor.userId && (hostOnly || !member)) throw new DeviceError(403, "This party is private.");
    return party;
  }

  private async partyView(tx: Tx, party: Party) {
    const people = await tx.select({ userId: users.id, name: users.name }).from(participants)
      .innerJoin(users, eq(users.id, participants.userId)).where(eq(participants.partyId, party.id)).limit(100);
    const [output] = await tx.select().from(devices).where(eq(devices.id, party.deviceId));
    const ids = [...new Set(party.queue)];
    const queueTracks = ids.length ? await tx.select({ id: tracks.id, title: tracks.title, artist: tracks.artist })
      .from(tracks).where(inArray(tracks.id, ids)) : [];
    return {
      id: party.id, name: party.name, hostId: party.hostId, deviceId: party.deviceId,
      queue: party.queue, queueTracks, revision: party.revision, guestsCanEdit: party.guestsCanEdit,
      expiresAt: party.expiresAt.toISOString(), participants: people,
      isHost: party.hostId === this.actor.userId,
      output: output ? { id: output.id, name: output.name, online: publicDevice(output, this.clock()).online,
        playing: output.state.playing, trackId: output.state.trackId } : null,
    };
  }

  async listParties() {
    return this.run(async (tx) => {
      const memberships = await tx.select({ partyId: participants.partyId }).from(participants)
        .where(eq(participants.userId, this.actor.userId));
      const ids = memberships.map((member) => member.partyId);
      const rows = await tx.select().from(parties).where(and(isNull(parties.closedAt),
        gt(parties.expiresAt, new Date(this.clock())),
        ids.length ? or(eq(parties.hostId, this.actor.userId), inArray(parties.id, ids)) : eq(parties.hostId, this.actor.userId)))
        .orderBy(desc(parties.createdAt)).limit(20);
      return Promise.all(rows.map((party) => this.partyView(tx, party)));
    });
  }

  async createParty(name: string, deviceId: string) {
    const title = registerDeviceSchema.shape.name.parse(name);
    return this.run(async (tx) => {
      const device = await this.owned(tx, deviceId);
      assertDeviceOnline(device, this.clock());
      const open = await tx.select({ id: parties.id }).from(parties)
        .where(and(eq(parties.deviceId, deviceId), isNull(parties.closedAt), gt(parties.expiresAt, new Date(this.clock()))));
      if (open.length) throw new DeviceError(409, "This device already hosts a party.");
      let queue = device.state.queue;
      if (device.state.queueContext) {
        const [context] = await tx.select().from(playbackQueues).where(and(eq(playbackQueues.id, device.state.queueContext.id),
          eq(playbackQueues.userId, this.actor.userId), gt(playbackQueues.expiresAt, new Date(this.clock()))));
        if (!context) throw new DeviceError(409, "The output's listening queue expired. Choose its music again.");
        if (context.total > 50_000) throw new DeviceError(400, "Parties support up to 50,000 entries. Choose a smaller playlist for this party; ordinary library playback remains unlimited.");
        queue = (await tx.select({ id: playbackQueueEntries.trackId }).from(playbackQueueEntries)
          .where(eq(playbackQueueEntries.queueId, context.id)).orderBy(playbackQueueEntries.position)).map((row) => row.id);
      }
      const [party] = await tx.insert(parties).values({
        hostId: this.actor.userId, deviceId, name: title, queue,
        expiresAt: new Date(this.clock() + PARTY_TTL_MS),
      }).returning();
      if (!party) throw new Error("Party was not stored");
      await tx.insert(participants).values({ partyId: party.id, userId: this.actor.userId });
      return this.partyView(tx, party);
    });
  }

  async getParty(id: string) { return this.run(async (tx) => this.partyView(tx, await this.party(tx, id))); }

  async invite(id: string, revoke = false) {
    return this.run(async (tx) => {
      const party = await this.party(tx, id, true);
      const secret = revoke ? null : token();
      const expiresAt = new Date(Math.min(this.clock() + 60 * 60_000, party.expiresAt.getTime()));
      await tx.update(parties).set({ inviteHash: secret ? hash(secret) : null, inviteExpiresAt: secret ? expiresAt : null })
        .where(eq(parties.id, id));
      return { code: secret ? `${id}.${secret}` : null, expiresAt: secret ? expiresAt.toISOString() : null };
    });
  }

  async join(code: string) {
    const [id, secret, extra] = code.split(".");
    if (!id || !secret || extra || !/^[0-9a-f-]{36}$/i.test(id) || secret.length !== 43) throw new DeviceError(400, "Invalid party invitation.");
    return this.run(async (tx) => {
      const [party] = await tx.select().from(parties).where(eq(parties.id, id)).for("update");
      if (!party || party.closedAt || party.expiresAt.getTime() <= this.clock() || !party.inviteHash ||
          !party.inviteExpiresAt || party.inviteExpiresAt.getTime() <= this.clock() || party.inviteHash !== hash(secret)) {
        throw new DeviceError(404, "Invitation expired or was revoked.");
      }
      const [stats] = await tx.select({ count: sql<number>`count(*)::int` }).from(participants).where(eq(participants.partyId, id));
      if ((stats?.count ?? 0) >= 100) throw new DeviceError(409, "This party is full.");
      await tx.insert(participants).values({ partyId: id, userId: this.actor.userId }).onConflictDoNothing();
      return this.partyView(tx, party);
    });
  }

  async editPartyQueue(id: string, revision: number, queue: string[]) {
    const parsed = deviceQueueSchema.parse(queue);
    return this.run(async (tx) => {
      const party = await this.party(tx, id);
      assertPartyEditor(party, this.actor.userId, true);
      assertPartyRevision(party.revision, revision);
      await this.readyTracks(tx, parsed);
      const [updated] = await tx.update(parties).set({ queue: parsed, revision: party.revision + 1 })
        .where(and(eq(parties.id, id), eq(parties.revision, revision))).returning();
      if (!updated) throw new DeviceError(409, "The queue changed. Refresh and retry.");
      return this.partyView(tx, updated);
    });
  }

  async partyControl(id: string, action: { action: string; value?: number; revision?: number; userId?: string; enabled?: boolean }) {
    return this.run(async (tx) => {
      const needsDevice = !["end", "permissions", "remove-member"].includes(action.action);
      let output: Device | undefined;
      if (needsDevice) {
        const [candidate] = await tx.select({ deviceId: parties.deviceId, hostId: parties.hostId }).from(parties).where(eq(parties.id, id));
        if (!candidate || candidate.hostId !== this.actor.userId) throw new DeviceError(403, "Only the host can control playback.");
        output = await this.owned(tx, candidate.deviceId);
      }
      const party = await this.party(tx, id, true);
      if (action.action === "end") {
        await tx.update(parties).set({ closedAt: new Date(this.clock()), inviteHash: null }).where(eq(parties.id, id));
        return { ok: true };
      }
      if (action.action === "permissions") {
        await tx.update(parties).set({ guestsCanEdit: action.enabled === true }).where(eq(parties.id, id));
        return { ok: true };
      }
      if (action.action === "remove-member") {
        if (!action.userId || action.userId === party.hostId) throw new DeviceError(400, "The host cannot be removed.");
        await tx.delete(participants).where(and(eq(participants.partyId, id), eq(participants.userId, action.userId)));
        // Removing a guest rotates away any invitation they might still hold.
        await tx.update(parties).set({ inviteHash: null, inviteExpiresAt: null }).where(eq(parties.id, id));
        return { ok: true };
      }
      const device = output ?? await this.owned(tx, party.deviceId);
      if (action.action === "apply-queue") {
        assertPartyRevision(party.revision, action.revision ?? -1);
        return this.enqueue(tx, device, { action: "queue", trackIds: party.queue, currentIndex: 0 });
      }
      const command = deviceCommandSchema.parse(action);
      if (!["play", "pause", "next", "previous", "volume", "seek"].includes(command.action)) {
        throw new DeviceError(400, "This control is not available in a party.");
      }
      return this.enqueue(tx, device, command);
    });
  }

  async leaveParty(id: string) {
    return this.run(async (tx) => {
      const party = await this.party(tx, id);
      if (party.hostId === this.actor.userId) throw new DeviceError(409, "End the party to leave as host.");
      await tx.delete(participants).where(and(eq(participants.partyId, id), eq(participants.userId, this.actor.userId)));
      return { ok: true };
    });
  }
}
