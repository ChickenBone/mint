import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@mint/core/schema";
import { DeviceError, type DeviceState } from "@mint/core/devices";
import { DeviceStore } from "../src/lib/devices-store";

const connectionString = process.env.DEVICE_TEST_DATABASE_URL;
test("PostgreSQL device and party isolation, claims, acknowledgments and revision conflicts", { skip: !connectionString }, async (t) => {
  const admin = new pg.Pool({ connectionString });
  const name = `mint_devices_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(connectionString!); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  try {
    const root = path.resolve(import.meta.dirname, "../../../packages/core/migrations");
    for (const file of ["0000_init.sql", "0001_workers.sql", "0002_drop_previews.sql", "0003_track_artwork_url.sql", "0004_existing_library.sql", "0007_devices.sql", "0018_device_lifecycle.sql"]) {
      await pool.query(await readFile(path.join(root, file), "utf8"));
    }
    const db = drizzle(pool, { schema });
    const host = randomUUID(), guest = randomUUID(), outsider = randomUUID(), track = randomUUID();
    const hostSession = randomUUID(), hostOtherSession = randomUUID(), guestSession = randomUUID(), outsiderSession = randomUUID();
    let now = Date.now();
    for (const [id, label] of [[host, "Host"], [guest, "Guest"], [outsider, "Outsider"]]) {
      await pool.query("INSERT INTO users(id,email,name,password_hash,status) VALUES($1,$2,$3,'unused','active')", [id, `${id}@example.test`, label]);
    }
    for (const [id, user] of [[hostSession, host], [hostOtherSession, host], [guestSession, guest], [outsiderSession, outsider]]) {
      await pool.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,$3)", [id, user, new Date(now + 24 * 3600_000)]);
    }
    await pool.query("INSERT INTO tracks(id,youtube_video_id,title,artist,stage,file_path) VALUES($1,'device-test','Test song','Test artist','ready','/test/device-fixture.flac')", [track]);
    const initial: DeviceState = { playing: true, time: 30, duration: 180, volume: 65, trackId: track, queue: [track], currentIndex: 0, shuffle: false, repeat: 0 };
    const hosts = new DeviceStore(db, { userId: host, sessionId: hostSession }, () => now);
    const secondSession = new DeviceStore(db, { userId: host, sessionId: hostOtherSession }, () => now);
    const guests = new DeviceStore(db, { userId: guest, sessionId: guestSession }, () => now);
    const outsiders = new DeviceStore(db, { userId: outsider, sessionId: outsiderSession }, () => now);
    const device = await hosts.register({ name: "Living room", state: initial });
    const source = await hosts.register({ name: "Source", state: initial });

    await t.test("ownership and exact receiver session/token boundaries", async () => {
      assert.deepEqual(await guests.list(), []);
      assert.equal((await hosts.list()).length, 2);
      await assert.rejects(() => guests.command(device.id, { action: "pause" }), (error) => error instanceof DeviceError && error.status === 404);
      await assert.rejects(() => hosts.poll(device.id, "wrong-token", initial), (error) => error instanceof DeviceError && error.status === 403);
      await assert.rejects(() => secondSession.poll(device.id, device.token, initial), (error) => error instanceof DeviceError && error.status === 403);
      const persisted = await hosts.register({ name: "This computer", state: initial });
      const resumed = await hosts.resume(persisted.id);
      assert.equal(resumed.id, persisted.id);
      assert.notEqual(resumed.token, persisted.token);
      await hosts.poll(persisted.id, resumed.token, initial);
      await assert.rejects(() => hosts.poll(persisted.id, persisted.token, initial), (error) => error instanceof DeviceError && error.status === 403);
      await assert.rejects(() => secondSession.resume(persisted.id), (error) => error instanceof DeviceError && error.status === 404);
      await hosts.revoke(persisted.id);
      assert.equal((await hosts.list())[0]?.state.queueLength, 1);
      assert.equal("tokenHash" in (await hosts.list())[0]!, false);
      assert.equal("authSessionId" in (await hosts.list())[0]!, false);
    });

    await t.test("concurrent polling claims only once; acknowledgment replay fails", async () => {
      const admitted = await hosts.command(device.id, { action: "pause" });
      const results = await Promise.all([hosts.poll(device.id, device.token, initial), hosts.poll(device.id, device.token, initial)]);
      assert.equal(results.filter((row) => row.command !== null).length, 1);
      assert.equal(results.find((row) => row.command)?.command?.id, admitted.id);
      const ack = { id: admitted.id, sequence: admitted.sequence, success: true, state: { ...initial, playing: false } };
      await hosts.acknowledge(device.id, device.token, ack);
      assert.equal((await hosts.commandStatus(admitted.id)).status, "succeeded");
      await assert.rejects(() => hosts.acknowledge(device.id, device.token, ack), (error) => error instanceof DeviceError && error.status === 409);
    });

    await t.test("delivered commands cannot be reissued; later command waits for acknowledgment", async () => {
      const first = await hosts.command(device.id, { action: "play" });
      await hosts.command(device.id, { action: "pause" });
      assert.equal((await hosts.poll(device.id, device.token, initial)).command?.id, first.id);
      assert.equal((await hosts.poll(device.id, device.token, initial)).command, null);
      await hosts.acknowledge(device.id, device.token, { id: first.id, sequence: first.sequence, success: true, state: initial });
      const second = (await hosts.poll(device.id, device.token, initial)).command!;
      assert.ok(second.sequence > first.sequence);
      await hosts.acknowledge(device.id, device.token, { id: second.id, sequence: second.sequence, success: true, state: { ...initial, playing: false } });
    });

    await t.test("expiration and stale receiver sessions never execute", async () => {
      const admitted = await hosts.command(device.id, { action: "play" });
      now += 21_000;
      assert.equal((await hosts.poll(device.id, device.token, initial)).command, null);
      assert.equal((await hosts.commandStatus(admitted.id)).status, "expired");
      now += 26_000;
      await assert.rejects(() => hosts.command(device.id, { action: "play" }), (error) => error instanceof DeviceError && error.status === 409);
      await hosts.poll(device.id, device.token, initial);
      await pool.query("UPDATE sessions SET expires_at=$2 WHERE id=$1", [hostSession, new Date(now - 1000)]);
      await assert.rejects(() => hosts.poll(device.id, device.token, initial), (error) => error instanceof DeviceError && error.status === 401);
      await assert.rejects(() => secondSession.command(device.id, { action: "play" }), (error) => error instanceof DeviceError && error.status === 409);
      await pool.query("UPDATE sessions SET expires_at=$2 WHERE id=$1", [hostSession, new Date(now + 24 * 3600_000)]);
    });

    await t.test("controller expiry cancels an admitted command before receiver delivery", async () => {
      const admitted = await secondSession.command(device.id, { action: "pause" });
      await pool.query("UPDATE sessions SET expires_at=$2 WHERE id=$1", [hostOtherSession, new Date(now - 1000)]);
      assert.equal((await hosts.poll(device.id, device.token, initial)).command, null);
      assert.equal((await pool.query("SELECT status FROM device_commands WHERE id=$1", [admitted.id])).rows[0].status, "failed");
      await pool.query("UPDATE sessions SET expires_at=$2 WHERE id=$1", [hostOtherSession, new Date(now + 24 * 3600_000)]);
    });

    await t.test("handoff confirms destination playback, not queue admission; no source pause is enqueued", async () => {
      await hosts.poll(source.id, source.token, initial);
      const admitted = await hosts.handoff(source.id, source.token, device.id, initial);
      assert.equal((await hosts.poll(source.id, source.token, initial)).command, null);
      assert.equal((await hosts.poll(device.id, device.token, initial)).command?.id, admitted.id);
      await assert.rejects(() => hosts.acknowledge(device.id, device.token, {
        id: admitted.id, sequence: admitted.sequence, success: true, state: { ...initial, playing: false },
      }), (error) => error instanceof DeviceError && error.status === 409);
      await hosts.acknowledge(device.id, device.token, { id: admitted.id, sequence: admitted.sequence, success: false, error: "Autoplay blocked", state: { ...initial, playing: false } });
      assert.equal((await hosts.commandStatus(admitted.id)).status, "failed");
      assert.equal((await hosts.poll(source.id, source.token, initial)).command, null);
      await assert.rejects(() => hosts.handoff(source.id, source.token, device.id, { ...initial, queue: [randomUUID()], trackId: randomUUID() }));
      const moved = await hosts.handoff(source.id, source.token, device.id, initial);
      await hosts.poll(device.id, device.token, initial);
      await hosts.acknowledge(device.id, device.token, { id: moved.id, sequence: moved.sequence, success: true, state: initial });
      assert.equal((await hosts.commandStatus(moved.id)).status, "succeeded");
    });

    await t.test("remote transfer completion waits for acknowledgment, binds the actor/source, detects source changes and cannot replay", async () => {
      await hosts.poll(source.id, source.token, initial);
      const admitted = await hosts.handoff(source.id, source.token, device.id, initial);
      await assert.rejects(() => hosts.completeTransfer(admitted.id), (error) => error instanceof DeviceError && error.status === 409);
      await assert.rejects(() => secondSession.completeTransfer(admitted.id), (error) => error instanceof DeviceError && error.status === 404);
      await hosts.poll(device.id, device.token, initial);
      await hosts.acknowledge(device.id, device.token, { id: admitted.id, sequence: admitted.sequence, success: true, state: initial });
      const changedId = randomUUID(), changed = { ...initial, trackId: changedId, queue: [changedId] };
      await hosts.poll(source.id, source.token, changed);
      await assert.rejects(() => hosts.completeTransfer(admitted.id), (error) => error instanceof DeviceError && error.status === 409);
      await hosts.poll(source.id, source.token, initial);
      const paused = await hosts.completeTransfer(admitted.id);
      assert.equal(paused.deviceId, source.id);
      assert.equal(paused.command.action, "pause");
      assert.ok(paused.command.action === "pause" && paused.command.expected?.trackId === initial.trackId);
      await assert.rejects(() => hosts.completeTransfer(admitted.id), (error) => error instanceof DeviceError && error.status === 404);
      const delivery = (await hosts.poll(source.id, source.token, changed)).command!;
      await hosts.acknowledge(source.id, source.token, { id: delivery.id, sequence: delivery.sequence, success: false,
        error: "Source changed tracks", state: changed });
      assert.equal((await hosts.commandStatus(paused.id)).status, "failed");
      await hosts.poll(source.id, source.token, initial);
    });

    await t.test("successful transfer completion expires at its deadline even if the source plays the same track again", async () => {
      for (const delay of [0, 5 * 60_000]) {
        await hosts.poll(source.id, source.token, initial);
        await hosts.poll(device.id, device.token, initial);
        const admitted = await hosts.handoff(source.id, source.token, device.id, initial);
        await hosts.poll(device.id, device.token, initial);
        await hosts.acknowledge(device.id, device.token, { id: admitted.id, sequence: admitted.sequence, success: true, state: initial });
        const changedId = randomUUID();
        await hosts.poll(source.id, source.token, { ...initial, trackId: changedId, queue: [changedId] });
        now = Date.parse(admitted.expiresAt) + delay;
        await hosts.poll(source.id, source.token, initial);
        assert.equal((await hosts.commandStatus(admitted.id)).status, "succeeded");
        await assert.rejects(() => secondSession.completeTransfer(admitted.id), (error) => error instanceof DeviceError && error.status === 404);
        for (let retry = 0; retry < 2; retry++) {
          await assert.rejects(() => hosts.completeTransfer(admitted.id),
            (error) => error instanceof DeviceError && error.status === 409 && /expired/i.test(error.message));
          assert.equal((await hosts.poll(source.id, source.token, initial)).command, null);
        }
        await hosts.poll(device.id, device.token, initial);
      }
    });

    let partyId = "", invitation = "";
    await t.test("party invitations are scoped and revocable; uninvited members cannot read", async () => {
      const party = await hosts.createParty("One room", device.id); partyId = party.id;
      await assert.rejects(() => outsiders.getParty(partyId), (error) => error instanceof DeviceError && error.status === 403);
      invitation = (await hosts.invite(partyId)).code!;
      const joined = await guests.join(invitation);
      assert.equal(joined.participants.length, 2);
      assert.equal(joined.isHost, false);
      await hosts.invite(partyId, true);
      await assert.rejects(() => outsiders.join(invitation), (error) => error instanceof DeviceError && error.status === 404);
      assert.equal((await guests.getParty(partyId)).id, partyId);
      await assert.rejects(() => guests.partyControl(partyId, { action: "pause" }), (error) => error instanceof DeviceError && error.status === 403);
      await assert.rejects(() => hosts.handoff(source.id, source.token, device.id, initial), (error) => error instanceof DeviceError && error.status === 409);
    });

    await t.test("guest permission and concurrent queue revisions preserve duplicate tracks", async () => {
      await assert.rejects(() => guests.editPartyQueue(partyId, 0, [track, track]), (error) => error instanceof DeviceError && error.status === 403);
      await hosts.partyControl(partyId, { action: "permissions", enabled: true });
      const attempts = await Promise.allSettled([
        guests.editPartyQueue(partyId, 0, [track, track]),
        hosts.editPartyQueue(partyId, 0, [track, track, track]),
      ]);
      assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
      const conflict = attempts.find((attempt) => attempt.status === "rejected") as PromiseRejectedResult;
      assert.equal(conflict.reason.status, 409);
      const current = await guests.getParty(partyId);
      assert.equal(current.revision, 1);
      assert.ok(current.queue.length >= 2);
      const applied = await hosts.partyControl(partyId, { action: "apply-queue", revision: 1 });
      assert.ok("id" in applied);
      const claim = (await hosts.poll(device.id, device.token, initial)).command!;
      assert.equal(claim.command.action, "queue");
      assert.equal((await hosts.poll(source.id, source.token, initial)).command, null);
      if (claim.command.action === "queue") {
        await hosts.acknowledge(device.id, device.token, { id: claim.id, sequence: claim.sequence, success: true,
          state: { ...initial, queue: claim.command.trackIds, currentIndex: 0 } });
      }
    });

    await t.test("removed guests lose queue and read permission; ending revokes access", async () => {
      invitation = (await hosts.invite(partyId)).code!;
      await hosts.partyControl(partyId, { action: "remove-member", userId: guest });
      await assert.rejects(() => guests.getParty(partyId), (error) => error instanceof DeviceError && error.status === 403);
      await assert.rejects(() => guests.join(invitation), (error) => error instanceof DeviceError && error.status === 404);
      await hosts.partyControl(partyId, { action: "end" });
      await assert.rejects(() => hosts.getParty(partyId), (error) => error instanceof DeviceError && error.status === 404);
    });

    await t.test("receiver revocation fails pending commands and blocks subsequent polls", async () => {
      const pending = await hosts.command(device.id, { action: "pause" });
      await hosts.revoke(device.id);
      assert.equal((await hosts.commandStatus(pending.id)).status, "failed");
      await assert.rejects(() => hosts.poll(device.id, device.token, initial), (error) => error instanceof DeviceError && error.status === 404);
    });

    await t.test("Web players are ephemeral, cleanup is account-scoped, native installations survive session rotation and expire after 30 days", async () => {
      const longExpiry = new Date(now + 40 * 24 * 3600_000);
      await pool.query("UPDATE sessions SET expires_at=$1", [longExpiry]);
      const installationId = randomUUID();
      const installed = new DeviceStore(db, { userId: host, sessionId: hostSession, installationId, deviceName: "Fixture phone" }, () => now);
      const native = await installed.register({ name: "ignored", state: initial });
      assert.equal(native.kind, "native");
      assert.equal(native.name, "Fixture phone");
      const web = await hosts.register({ name: "Misleading phone", kind: "native", state: initial });
      assert.equal(web.kind, "web", "Cookie registration cannot claim installed identity");
      assert.equal(web.name, "Web player");
      const guestWeb = await guests.register({ name: "Guest browser", state: initial });
      await hosts.disconnect(web.id, web.token);
      assert.equal((await hosts.list()).some((row) => row.id === web.id), false);
      await assert.rejects(() => hosts.resume(web.id), (error) => error instanceof DeviceError && error.status === 404);
      const crashed = await hosts.register({ name: "Crashed tab", state: initial });
      now += 25_001;
      assert.equal((await hosts.list()).some((row) => row.id === crashed.id), false);
      assert.equal((await pool.query("SELECT id FROM connected_devices WHERE id=$1", [guestWeb.id])).rowCount, 1, "Host cleanup cannot touch guest data");
      await pool.query("DELETE FROM sessions WHERE id=$1", [hostSession]);
      const rotated = new DeviceStore(db, { userId: host, sessionId: hostOtherSession, installationId, deviceName: "Fixture phone" }, () => now);
      assert.equal((await secondSession.list()).find((row) => row.id === native.id)?.online, false);
      const reconnected = await rotated.register({ name: "ignored", state: initial });
      assert.equal(reconnected.id, native.id);
      await assert.rejects(() => rotated.poll(native.id, native.token, initial), (error) => error instanceof DeviceError && error.status === 403);
      await rotated.disconnect(native.id, reconnected.token);
      now += 30 * 24 * 3600_000;
      assert.equal((await secondSession.list()).some((row) => row.id === native.id), true, "Retained at the exact 30-day boundary");
      now += 1;
      assert.equal((await secondSession.list()).some((row) => row.id === native.id), false);
      const sameInstallationGuest = new DeviceStore(db, { userId: guest, sessionId: guestSession, installationId }, () => now);
      const guestNative = await sameInstallationGuest.register({ name: "Guest phone", state: initial });
      const newHostNative = await rotated.register({ name: "Host phone", state: initial });
      assert.notEqual(guestNative.id, newHostNative.id, "Installation identity is scoped to the account");
    });
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  }
});
