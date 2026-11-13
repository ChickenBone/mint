import { z } from "zod";
import { accountPrincipalSchema } from "./accounts";
import { browserSessionTokenSchema } from "./browser-session";

export const TRUSTED_CLIENT_IP_HEADER = "x-mint-client-ip";

/** Canonicalize equivalent addresses before they become rate-limit keys. */
export const trustedClientIpSchema = z.union([z.ipv4(), z.ipv6()]).transform((ip) => {
  if (!ip.includes(":")) return ip;
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const high = Number.parseInt(mapped[1]!, 16);
  const low = Number.parseInt(mapped[2]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
});

export const browserSignInResultSchema = z.union([
  z.strictObject({
    principal: accountPrincipalSchema,
    token: browserSessionTokenSchema,
    expiresAt: z.iso.datetime(),
  }),
  z.strictObject({
    error: z.string().max(500),
    status: z.union([z.literal(401), z.literal(403), z.literal(429), z.literal(503)]),
  }),
]);
export type BrowserSignInResult = z.infer<typeof browserSignInResultSchema>;

export const accountAccessRequestResultSchema = z.union([
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ error: z.string().max(500) }),
  z.strictObject({ fieldErrors: z.record(z.string(), z.string().max(500)) }),
]);
export type AccountAccessRequestResult = z.infer<typeof accountAccessRequestResultSchema>;
