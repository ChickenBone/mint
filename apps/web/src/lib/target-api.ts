import "server-only";
import {
  BROWSER_SESSION_COOKIE_NAME, browserSessionTokenSchema, gatewayTokenSchema,
  GATEWAY_TOKEN_HEADER_NAME,
} from "@mint/contracts";
import { createMintSdk, MintSdkError } from "@mint/sdk";
import { trustedIngressIp, TrustedIngressError } from "./trusted-ingress";

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

/** Only explicitly validated credentials and ingress evidence cross this boundary. */
export function targetApi(request: Request, mutation = false, publicAuthentication = false) {
  const config = configuration();
  if (mutation && request.headers.get("origin") !== config.origin) {
    throw new TargetRequestError("Forbidden origin.", 403);
  }
  const sdk = createMintSdk({
    url: config.url, gatewayToken: config.gatewayToken,
    sessionToken: publicAuthentication ? undefined : sessionToken(request),
    ...(publicAuthentication ? {
      trustedClientIp: trustedIngressIp(request.headers),
      userAgent: request.headers.get("user-agent")?.slice(0, 300),
    } : {}),
  });
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
  return { sdk, signal };
}

export async function targetMedia(request: Request, mediaFileId: string): Promise<Response> {
  const config = configuration();
  const token = sessionToken(request);
  if (!token) throw new TargetRequestError("Approved membership required.", 401);
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new TargetRequestError("Method not allowed.", 405);
  }

  const endpoint = new URL(config.url);
  endpoint.pathname = `/media/${encodeURIComponent(mediaFileId)}`;
  endpoint.search = "";
  endpoint.hash = "";
  const headers = new Headers({
    [GATEWAY_TOKEN_HEADER_NAME]: config.gatewayToken,
    cookie: `${BROWSER_SESSION_COOKIE_NAME}=${token}`,
  });
  const range = request.headers.get("range");
  if (range !== null) headers.set("range", range);

  const controller = new AbortController();
  const abort = () => controller.abort(request.signal.reason);
  if (request.signal.aborted) abort();
  else request.signal.addEventListener("abort", abort, { once: true });

  let upstream: Response;
  const connectTimeout = setTimeout(() => controller.abort(), 10_000);
  try {
    upstream = await fetch(endpoint, {
      method: request.method,
      headers,
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    request.signal.removeEventListener("abort", abort);
    if (request.signal.aborted) throw new TargetRequestError("Request cancelled.", 499);
    throw new MintSdkError("TRANSPORT_ERROR");
  } finally {
    clearTimeout(connectTimeout);
  }

  const forwarded = new Headers({ "cache-control": "private, no-store" });
  if (upstream.status === 416) {
    const contentRange = upstream.headers.get("content-range");
    if (!request.headers.has("range") || !contentRange || !/^bytes \*\/(?:0|[1-9]\d*)$/.test(contentRange)) {
      request.signal.removeEventListener("abort", abort);
      await upstream.body?.cancel();
      throw new MintSdkError("INCOMPATIBLE_RESPONSE");
    }
    forwarded.set("content-range", contentRange);
    request.signal.removeEventListener("abort", abort);
    await upstream.body?.cancel();
    return new Response(null, { status: upstream.status, headers: forwarded });
  }
  if (upstream.status !== 200 && upstream.status !== 206) {
    request.signal.removeEventListener("abort", abort);
    await upstream.body?.cancel();
    const messages: Record<number, string> = {
      400: "Invalid media range.",
      401: "Approved membership required.",
      403: "Playback is not allowed.",
      404: "Media not found.",
      415: "The original audio format is not supported.",
      503: "Media is unavailable.",
    };
    const message = messages[upstream.status];
    if (message) return targetResponse({ error: message }, upstream.status);
    throw new MintSdkError("RPC_ERROR");
  }

  const contentType = upstream.headers.get("content-type");
  const contentLength = upstream.headers.get("content-length");
  const acceptRanges = upstream.headers.get("accept-ranges");
  const contentRange = upstream.headers.get("content-range");
  const parsedContentRange = contentRange
    ? /^bytes (0|[1-9]\d*)-(0|[1-9]\d*)\/(0|[1-9]\d*)$/.exec(contentRange)
    : null;
  const contentLengthNumber = contentLength === null ? NaN : Number(contentLength);
  const validPartialRange = parsedContentRange !== null
    && parsedContentRange.slice(1).every((part) => Number.isSafeInteger(Number(part)))
    && Number(parsedContentRange[2]) >= Number(parsedContentRange[1])
    && Number(parsedContentRange[2]) < Number(parsedContentRange[3])
    && Number(parsedContentRange[2]) - Number(parsedContentRange[1]) + 1 === contentLengthNumber;
  if (!contentType || !/^audio\/[a-z0-9.+-]+$/i.test(contentType)
    || !contentLength || !/^(?:0|[1-9]\d*)$/.test(contentLength)
    || !Number.isSafeInteger(contentLengthNumber) || acceptRanges !== "bytes"
    || (request.headers.has("range") !== (upstream.status === 206))
    || (upstream.status === 200 && contentRange !== null)
    || (upstream.status === 206 && !validPartialRange)) {
    request.signal.removeEventListener("abort", abort);
    await upstream.body?.cancel();
    throw new MintSdkError("INCOMPATIBLE_RESPONSE");
  }
  forwarded.set("content-type", contentType);
  forwarded.set("content-length", contentLength);
  forwarded.set("accept-ranges", acceptRanges);
  if (contentRange !== null) forwarded.set("content-range", contentRange);

  const bodyless = request.method === "HEAD";
  if (bodyless) {
    request.signal.removeEventListener("abort", abort);
    await upstream.body?.cancel();
    return new Response(null, { status: upstream.status, headers: forwarded });
  }
  const body = upstream.body;
  if (!body) {
    request.signal.removeEventListener("abort", abort);
    throw new MintSdkError("INCOMPATIBLE_RESPONSE");
  }
  const reader = body.getReader();
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    request.signal.removeEventListener("abort", abort);
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(sink) {
      try {
        const result = await reader.read();
        if (result.done) {
          cleanup();
          sink.close();
        } else {
          sink.enqueue(result.value);
        }
      } catch (error) {
        cleanup();
        sink.error(error);
      }
    },
    async cancel(reason) {
      cleanup();
      await reader.cancel(reason);
    },
  });
  return new Response(stream, { status: upstream.status, headers: forwarded });
}

export function targetFailure(error: unknown): Response {
  if (error instanceof TargetRequestError) {
    if (error.status === 499) return new Response(null, { status: 499, headers: { "cache-control": "private, no-store" } });
    return targetResponse({ error: error.message }, error.status);
  }
  // Only fixed categories are logged; upstream errors can contain private connection data.
  const configurationFailure = error instanceof TargetConfigurationError || error instanceof TrustedIngressError;
  console.error(configurationFailure ? "TargetApiConfigurationError" : "TargetApiRequestError");
  return targetResponse(
    { error: "Target API unavailable." },
    configurationFailure ? 503 : error instanceof MintSdkError ? 502 : 500,
  );
}
