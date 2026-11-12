export function nativeWebOriginAllowed(origin: string | null, serverOrigin: string, configured: string) {
  return origin === null || origin === serverOrigin ||
    configured.split(",").map((value) => value.trim()).filter(Boolean).includes(origin);
}

export async function nativeHttp(request: Request, handle: () => Promise<Response>) {
  const origin = request.headers.get("origin");
  const allowed = nativeWebOriginAllowed(origin, new URL(process.env.PUBLIC_URL ?? request.url).origin, process.env.NATIVE_WEB_ORIGINS ?? "");
  const headers = new Headers({ "cache-control": "private, no-store", vary: "Authorization, Origin" });
  if (!allowed) return Response.json({ error: "This web app origin is not allowed by the server." }, { status: 403, headers });
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-methods", "GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS");
    headers.set("access-control-allow-headers", "Authorization, Content-Type, Range");
    headers.set("access-control-expose-headers", "Content-Length, Content-Range, Accept-Ranges, Retry-After");
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  const response = await handle();
  for (const [name, value] of headers) response.headers.set(name, value);
  return response;
}

export function nativeRouteAllowed(path: string[], method: string) {
  if (path.some((part) => !part || part === "." || part === ".." || part.includes("/") || part.includes("\\"))) return false;
  const key = path.join("/");
  if (/^player\/(catalog|session|offline)$/.test(key)) return method === "GET";
  if (/^player\/(audio|info|lyrics)\/[^/]+$/.test(key)) return method === "GET" || (path[1] === "audio" && method === "HEAD");
  if (/^player\/analysis\/[^/]+$/.test(key)) return method === "GET";
  if (/^player\/queue(\/[^/]+)?$/.test(key)) return method === "GET" || method === "POST";
  if (key === "player/items") return method === "POST";
  if (key === "issue-reports") return method === "POST";
  if (key === "music/search") return method === "GET" || method === "POST";
  if (key === "music/search/requests") return method === "GET" || method === "POST";
  if (key === "music/search/collection") return method === "GET";
  // Consumer discovery reads only; chart acquisition and provider setup stay on the cookie web app.
  if (key === "browse" || key === "charts") return method === "GET";
  if (path[0] === "music" && path[1] === "sources") return path.length === 3 && (method === "GET" || method === "POST");
  if (path[0] !== "music" || path.length > 4) return false;
  if (!["collections", "folders", "preferences", "history", "likes", "exclusions", "discover", "library"].includes(path[1] ?? "")) return false;
  return ["GET", "POST", "PATCH", "PUT", "DELETE"].includes(method);
}
