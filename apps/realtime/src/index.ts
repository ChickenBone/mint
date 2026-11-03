import http from "node:http";
import { CHANNEL, type RealtimeEvent } from "@mint/core";
import { SESSION_COOKIE, sha256, verifyToken } from "@mint/core/crypto";
import { getDb, schema } from "@mint/core/db";
import { createRedis, getRedis } from "@mint/core/redis";
import { and, eq, gt, inArray } from "drizzle-orm";
import pino from "pino";
import { WebSocketServer, type WebSocket } from "ws";

const log = pino({ level: process.env.LOG_LEVEL ?? "info", base: { service: "mint-realtime" } });
const PORT = Number(process.env.PORT ?? 3001);
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS ?? process.env.PUBLIC_URL ?? "http://localhost:3000").split(",").map((o) => o.trim()),
);
const MAX_CONNECTIONS_PER_IP = Number(process.env.WS_MAX_PER_IP ?? 20);

interface Client {
  ws: WebSocket;
  userId: string | null;
  role: "user" | "admin" | null;
  sessionId: string | null;
  alive: boolean;
  ip: string;
}

const clients = new Set<Client>();
const perIp = new Map<string, number>();

function parseCookies(header: string | undefined) {
  const out: Record<string, string> = {};
  for (const part of header?.split(";") ?? []) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Accepts a signed ticket from the web app (cross-origin deployments) or the session cookie (same origin). */
async function authenticate(cookieHeader: string | undefined, ticket: string | null) {
  const fromTicket = ticket ? verifyToken<{ sid: string }>("ws", ticket)?.sid : undefined;
  const cookie = parseCookies(cookieHeader)[SESSION_COOKIE];
  const sessionId = fromTicket ?? (cookie ? sha256(cookie) : undefined);
  if (!sessionId) return null;
  const db = getDb();
  const [row] = await db
    .select({ id: schema.users.id, name: schema.users.name, role: schema.users.role, status: schema.users.status })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.id, sessionId), gt(schema.sessions.expiresAt, new Date())))
    .limit(1);
  return row && row.status === "active" ? { ...row, sessionId } : null;
}

function send(ws: WebSocket, event: RealtimeEvent | string) {
  if (ws.readyState !== ws.OPEN) return;
  // Drop messages for slow consumers instead of buffering unbounded memory.
  if (ws.bufferedAmount > 1_000_000) return;
  ws.send(typeof event === "string" ? event : JSON.stringify(event));
}

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, clients: clients.size }));
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });

server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://x");
  const origin = req.headers.origin;
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "?";
  if (url.pathname !== "/ws" || (origin && !allowedOrigins.has(origin))) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    return socket.destroy();
  }
  if ((perIp.get(ip) ?? 0) >= MAX_CONNECTIONS_PER_IP) {
    socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
    return socket.destroy();
  }
  let user: Awaited<ReturnType<typeof authenticate>> = null;
  try {
    user = await authenticate(req.headers.cookie, url.searchParams.get("ticket"));
  } catch (err) {
    log.error({ err }, "auth lookup failed");
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const client: Client = { ws, userId: user?.id ?? null, role: user?.role ?? null, sessionId: user?.sessionId ?? null, alive: true, ip };
    clients.add(client);
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    ws.on("pong", () => (client.alive = true));
    // Clients only listen; any inbound frame other than a ping is ignored.
    ws.on("message", (data) => {
      if (data.toString() === "ping") send(ws, '{"type":"pong"}');
    });
    ws.on("close", () => {
      clients.delete(client);
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ip);
      else perIp.set(ip, n);
    });
    send(ws, { type: "hello", data: { user: user ? { id: user.id, name: user.name, role: user.role } : null } });
    void getRedis()
      .get("mint:stats")
      .then((s) => s && send(ws, `{"type":"stats","data":${s}}`));
  });
});

/** Closes authenticated sockets whose session was revoked (logout, disabled account) since they connected. */
async function revalidateSessions() {
  const authed = [...clients].filter((c) => c.sessionId);
  if (!authed.length) return;
  const ids = [...new Set(authed.map((c) => c.sessionId!))];
  const live = await getDb()
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(inArray(schema.sessions.id, ids), gt(schema.sessions.expiresAt, new Date()), eq(schema.users.status, "active")));
  const ok = new Set(live.map((l) => l.id));
  for (const c of authed) if (!ok.has(c.sessionId!)) c.ws.close(4401, "session ended");
}
const revalidate = setInterval(() => void revalidateSessions().catch((err) => log.warn({ err }, "revalidate failed")), 60_000);

const heartbeat = setInterval(() => {
  for (const c of clients) {
    if (!c.alive) {
      c.ws.terminate();
      continue;
    }
    c.alive = false;
    c.ws.ping();
  }
}, 30_000);

const sub = createRedis();
await sub.subscribe(CHANNEL.public, CHANNEL.admin);
await sub.psubscribe(`${CHANNEL.user("")}*`);

sub.on("message", (channel, message) => {
  for (const c of clients) {
    if (channel === CHANNEL.public || (channel === CHANNEL.admin && c.role === "admin")) send(c.ws, message);
  }
});
sub.on("pmessage", (_pattern, channel, message) => {
  const userId = channel.slice(CHANNEL.user("").length);
  for (const c of clients) if (c.userId === userId) send(c.ws, message);
});

server.listen(PORT, () => log.info({ port: PORT }, "mint realtime listening"));

const shutdown = () => {
  clearInterval(heartbeat);
  clearInterval(revalidate);
  for (const c of clients) c.ws.close(1001, "server shutting down");
  server.close(() => process.exit(0));
  void sub.quit();
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
