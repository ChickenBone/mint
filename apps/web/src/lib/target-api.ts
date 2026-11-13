import "server-only";
import {
  BROWSER_SESSION_COOKIE_NAME, browserSessionTokenSchema, gatewayTokenSchema,
} from "@mint/contracts";
import { createMintSdk, MintSdkError } from "@mint/sdk";

class TargetConfigurationError extends Error {}

export class TargetRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function targetResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}

function configuration() {
  const url = process.env.MINT_TARGET_API_URL;
  const gatewayToken = gatewayTokenSchema.safeParse(process.env.MINT_TARGET_GATEWAY_TOKEN);
  const origin = process.env.MINT_TARGET_WEB_ORIGIN;
  try {
    if (!url || !origin || !gatewayToken.success) {
      throw new TargetConfigurationError();
    }
    const api = new URL(url);
    const web = new URL(origin);
    if (!["http:", "https:"].includes(api.protocol) || api.username || api.password
      || api.search || api.hash || api.pathname !== "/trpc"
      || !["http:", "https:"].includes(web.protocol) || web.origin !== origin) {
      throw new TargetConfigurationError();
    }
    return { url, gatewayToken: gatewayToken.data, origin };
  } catch {
    throw new TargetConfigurationError();
  }
}

function sessionToken(request: Request): string | undefined {
  const header = request.headers.get("cookie");
  if (header === null) return undefined;
  const invalid = () => new TargetRequestError("Invalid browser session.", 401);
  if (header.length > 8192) throw invalid();
  let token: string | undefined;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) throw invalid();
    const name = pair.slice(0, separator).trim();
    if (name !== BROWSER_SESSION_COOKIE_NAME) continue;
    const value = pair.slice(separator + 1);
    // Issued browser credentials are unquoted base64url, not decoded cookie values.
    if (token !== undefined || pair.slice(0, separator).trimStart() !== name
      || !browserSessionTokenSchema.safeParse(value).success) throw invalid();
    token = value;
  }
  return token;
}

/** Server-only binding: never pass request headers, identity or client IP to the SDK. */
export function targetApi(request: Request, mutation = false) {
  const config = configuration();
  if (mutation && request.headers.get("origin") !== config.origin) {
    throw new TargetRequestError("Forbidden origin.", 403);
  }
  const sdk = createMintSdk({
    url: config.url, gatewayToken: config.gatewayToken, sessionToken: sessionToken(request),
  });
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
  return { sdk, signal };
}

export function targetFailure(error: unknown): Response {
  if (error instanceof TargetRequestError) {
    return targetResponse({ error: error.message }, error.status);
  }
  // Only fixed categories are logged; upstream errors can contain private connection data.
  const configurationFailure = error instanceof TargetConfigurationError;
  console.error(configurationFailure ? "TargetApiConfigurationError" : "TargetApiRequestError");
  return targetResponse(
    { error: "Target API unavailable." },
    configurationFailure ? 503 : error instanceof MintSdkError ? 502 : 500,
  );
}
