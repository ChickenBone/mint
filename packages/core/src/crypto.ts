import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY is not set");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64 encoded");
  return buf;
}

/** AES-256-GCM; output is iv.tag.ciphertext (base64url). */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString("base64url")).join(".");
}

export function decrypt(payload: string): string {
  const [iv, tag, enc] = payload.split(".").map((p) => Buffer.from(p, "base64url"));
  if (!iv || !tag || !enc) throw new Error("Malformed ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export const SESSION_COOKIE = "mint_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function signingKey(): string {
  const k = process.env.MINT_SIGNING_SECRET;
  if (!k || k.length < 32) throw new Error("MINT_SIGNING_SECRET must be set (at least 32 characters)");
  return k;
}

/** Compact HMAC-signed token `payload.sig` with an expiry, shared between Vercel, the hub and the realtime gateway. */
export function signToken<T extends object>(purpose: string, payload: T, ttlMs: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, p: purpose, exp: Date.now() + ttlMs })).toString("base64url");
  const sig = createHmac("sha256", signingKey()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken<T extends object>(purpose: string, token: string | null | undefined): T | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", signingKey()).update(body).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { p: string; exp: number };
    if (data.p !== purpose || typeof data.exp !== "number" || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

export const WORKER_TOKEN_PREFIX = "mint_wk_";

export function newWorkerToken() {
  const token = `${WORKER_TOKEN_PREFIX}${randomToken(32)}`;
  return { token, hash: sha256(token), hint: token.slice(0, WORKER_TOKEN_PREFIX.length + 6) };
}
