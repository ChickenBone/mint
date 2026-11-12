import "server-only";
import { z } from "zod";
import { cookies } from "next/headers";
import { getDb } from "@mint/core/db";
import { SESSION_COOKIE, sha256 } from "@mint/core/crypto";
import { DeviceError, deviceHeartbeatSchema, deviceStateSchema, partyQueueSchema } from "@mint/core/devices";
import { getUser } from "./auth";
import { allowedOrigins } from "./request";
import { DeviceStore } from "./devices-store";
import { validDeviceOrigin } from "./device-http";
import { currentNativeContext, isNativeTransportRequest } from "./native-context";

const json = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { "cache-control": "private, no-store", "vary": "Cookie" },
});
const id = z.uuid();
const receiver = z.object({ token: z.string().min(32).max(100) });
const heartbeat = receiver.extend({ state: deviceHeartbeatSchema });
const control = z.discriminatedUnion("action", [
  z.object({ action: z.literal("end") }),
  z.object({ action: z.literal("permissions"), enabled: z.boolean() }),
  z.object({ action: z.literal("remove-member"), userId: z.uuid() }),
  z.object({ action: z.literal("apply-queue"), revision: z.number().int().nonnegative() }),
  z.object({ action: z.enum(["play", "pause", "next", "previous"]) }),
  z.object({ action: z.literal("volume"), value: z.number().min(0).max(100) }),
  z.object({ action: z.literal("seek"), value: z.number().min(0).max(7 * 86400) }),
]);

async function body(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new DeviceError(415, "Send JSON for device actions.");
  }
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 3 * 1024 * 1024) throw new DeviceError(413, "Request is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new DeviceError(400, "A request body is required.");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    bytes += result.value.byteLength;
    if (bytes > 3 * 1024 * 1024) { await reader.cancel(); throw new DeviceError(413, "Request is too large."); }
    chunks.push(result.value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new DeviceError(400, "Invalid JSON."); }
}

export async function deviceApi(request: Request, path: string[], kind: "devices" | "parties") {
  try {
    const native = isNativeTransportRequest(request) ? currentNativeContext() : undefined;
    if (request.method !== "GET" && !native && !validDeviceOrigin(request, allowedOrigins())) throw new DeviceError(403, "Same-origin requests only.");
    const user = await getUser();
    const cookie = native ? undefined : (await cookies()).get(SESSION_COOKIE)?.value;
    if (!user || (!native && !cookie)) throw new DeviceError(401, "Approved membership required.");
    const store = new DeviceStore(getDb(), { userId: user.id, sessionId: native?.sessionHash ?? sha256(cookie!),
      installationId: native?.installationId, deviceName: native?.deviceName });
    const [target, action, extra] = path;
    if (extra) throw new DeviceError(404, "Action not found.");
    if (request.method === "GET") {
      if (!target) return json(kind === "devices" ? await store.list() : await store.listParties());
      if (kind === "devices" && target === "commands" && action) return json(await store.commandStatus(id.parse(action)));
      if (kind === "devices" && !action) return json(await store.getDevice(id.parse(target)));
      if (kind === "parties" && !action) return json(await store.getParty(id.parse(target)));
      throw new DeviceError(404, "Action not found.");
    }
    const input = await body(request);
    if (kind === "devices") {
      if (!target) return json(await store.register(input), 201);
      if (target === "transfer" && !action) {
        return json(await store.transfer(z.object({ destinationId: z.uuid() }).parse(input).destinationId), 202);
      }
      if (target === "complete-transfer" && !action) {
        return json(await store.completeTransfer(z.object({ commandId: z.uuid() }).parse(input).commandId), 202);
      }
      id.parse(target);
      if (action === "resume") return json(await store.resume(target));
      if (action === "disconnect") return json(await store.disconnect(target, receiver.parse(input).token));
      if (action === "position") {
        const data = z.object({ time: z.number().finite().min(0).max(7 * 86400), scrubbing: z.boolean() }).parse(input);
        return json(await store.preview(target, data.time, data.scrubbing));
      }
      if (action === "poll") {
        const data = heartbeat.parse(input);
        return json(await store.poll(target, data.token, data.state));
      }
      if (action === "ack") {
        const data = receiver.passthrough().parse(input);
        return json(await store.acknowledge(target, data.token, input));
      }
      if (action === "commands") return json(await store.command(target, input), 202);
      if (action === "rename") return json(await store.rename(target, z.object({ name: z.string() }).parse(input).name));
      if (action === "revoke") return json(await store.revoke(target));
      if (action === "handoff") {
        const data = receiver.extend({ state: deviceStateSchema, destinationId: z.uuid() }).parse(input);
        return json(await store.handoff(target, data.token, data.destinationId, data.state), 202);
      }
    } else {
      if (!target) {
        const data = z.object({ name: z.string(), deviceId: z.uuid() }).parse(input);
        return json(await store.createParty(data.name, data.deviceId), 201);
      }
      if (target === "join" && !action) return json(await store.join(z.object({ code: z.string().trim().max(120) }).parse(input).code));
      id.parse(target);
      if (action === "queue") {
        const data = partyQueueSchema.parse(input);
        return json(await store.editPartyQueue(target, data.revision, data.queue));
      }
      if (action === "invite") return json(await store.invite(target, z.object({ revoke: z.boolean().default(false) }).parse(input).revoke));
      if (action === "control") return json(await store.partyControl(target, control.parse(input)));
      if (action === "leave") return json(await store.leaveParty(target));
    }
    throw new DeviceError(404, "Action not found.");
  } catch (error) {
    if (error instanceof DeviceError) return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError) return json({ error: "Invalid device or party action.", details: error.issues.slice(0, 5).map((issue) => issue.message) }, 400);
    console.error("[devices] request failed", error instanceof Error ? error.message : "Unknown failure");
    return json({ error: "Device service is unavailable. Try again shortly." }, 503);
  }
}
