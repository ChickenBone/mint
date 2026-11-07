import { headers } from "next/headers";

/** Client IP as seen by the reverse proxy (Caddy sets X-Forwarded-For; only trust the first hop). */
export async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}

export async function userAgent(): Promise<string | null> {
  return (await headers()).get("user-agent");
}

export function publicUrl() {
  return (process.env.PUBLIC_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

/** Origins that may call this instance. ALLOWED_ORIGINS can list localhost plus a Tailscale hostname. */
export function allowedOrigins() {
  const configured = `${process.env.ALLOWED_ORIGINS ?? ""},${publicUrl()}`
    .split(",").map((value) => value.trim()).filter(Boolean);
  const origins = new Set<string>();
  for (const value of configured) {
    try { origins.add(new URL(value).origin); } catch { /* ignore malformed entries */ }
  }
  return [...origins];
}

export function originAllowed(origin: string | null) {
  return Boolean(origin && allowedOrigins().includes(origin));
}

/** Mutations from the browser. Next can report the request URL as localhost while the page is another configured host. */
export function mutationOriginAllowed(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    if (origin === new URL(request.url).origin) return true;
  } catch { /* a malformed request URL still has to match the allowlist */ }
  return originAllowed(origin);
}

export class RequestInputError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export async function boundedJson(request: Request, maxBytes: number): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new RequestInputError("Send a JSON request.", 400);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new RequestInputError(`Request exceeds the ${maxBytes}-byte limit.`, 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
