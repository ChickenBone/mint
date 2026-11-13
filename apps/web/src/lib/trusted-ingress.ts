import { timingSafeEqual } from "node:crypto";
import { gatewayTokenSchema, TRUSTED_CLIENT_IP_HEADER, trustedClientIpSchema } from "@mint/contracts";

export class TrustedIngressError extends Error {
  constructor() { super("Trusted ingress is unavailable."); }
}

/**
 * Next does not expose the socket peer to server actions. An authenticated ingress
 * must replace both headers; ordinary Forwarded/X-Forwarded-For are never evidence.
 */
export function trustedIngressIp(headers: Headers, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const expected = gatewayTokenSchema.safeParse(env.MINT_TARGET_INGRESS_TOKEN);
  const supplied = gatewayTokenSchema.safeParse(headers.get("x-mint-ingress-token"));
  const ip = trustedClientIpSchema.safeParse(headers.get(TRUSTED_CLIENT_IP_HEADER));
  if (env.MINT_TARGET_TRUSTED_PROXY !== "authenticated-ingress"
    || !expected.success || !supplied.success || !ip.success
    || !timingSafeEqual(Buffer.from(expected.data, "ascii"), Buffer.from(supplied.data, "ascii"))) {
    throw new TrustedIngressError();
  }
  return ip.data;
}
