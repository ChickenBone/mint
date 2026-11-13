import { z } from "zod";

export const GATEWAY_TOKEN_HEADER_NAME = "x-mint-gateway-token";

/** Canonical encoding of 32 bytes; format validation cannot prove randomness. */
export const gatewayTokenSchema = z.string().length(43)
  .regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
