import { cookies } from "next/headers";
import { SESSION_COOKIE, sha256, signToken } from "@mint/core/crypto";
import { UUID, type PlaybackClaim } from "@mint/core/playback";
import { destroySession, getUser } from "@/lib/auth";
import { CatalogInputError, catalogResponse } from "@/lib/player-catalog";
import { publicUrl } from "@/lib/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } });

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const user = await getUser();
  if (!user) return json({ error: "Approved membership required" }, 401);
  const parts = (await context.params).path;
  const url = new URL(request.url);
  const endpoint = "/" + parts.slice(1).join("/");
  if (parts[0] === "audio") {
    const id = parts[1] ?? "";
    if (!UUID.test(id) || parts.length !== 2) return json({ error: "Invalid track" }, 400);
    const session = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!session) return json({ error: "Sign in required" }, 401);
    const token = signToken<PlaybackClaim>("playback", { userId: user.id, sessionHash: sha256(session), trackId: id }, 30_000);
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (request.headers.has("range")) headers.range = request.headers.get("range")!;
    let response: Response;
    try {
      response = await fetch(`${process.env.PLAYBACK_WORKER_URL ?? "http://worker:8080"}/playback/${id}`, {
        headers, cache: "no-store", signal: request.signal, redirect: "error", method: request.method,
      });
    } catch (error) {
      console.error("Playback worker unavailable", error instanceof Error ? error.message : "Network failure");
      return json({ error: "Playback worker unavailable; check the worker connection" }, 503);
    }
    const forwarded = new Headers({ "cache-control": "private, no-store" });
    for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const value = response.headers.get(name);
      if (value) forwarded.set(name, value);
    }
    return new Response(response.body, { status: response.status, headers: forwarded });
  }
  if (parts[0] === "cloud") {
    if (endpoint === "/api/v2/user.json") return json({ id: 1, uuid: user.id, title: user.name, subscription: { active: false, features: [] }, entitlements: [], providers: [], roles: [] });
    if (endpoint === "/api/v2/resources") return json([{
      name: "Mint", clientIdentifier: "mint", provides: "server", product: "Plex Media Server", productVersion: "1.42.0",
      owned: true, accessToken: "mint-session", connections: [{ uri: `${publicUrl()}/listen/api/server`, local: true, relay: false,
        protocol: new URL(publicUrl()).protocol.slice(0, -1), address: new URL(publicUrl()).hostname,
        port: Number(new URL(publicUrl()).port) || (publicUrl().startsWith("https:") ? 443 : 80) }],
    }]);
    if (endpoint === "/api/users" || endpoint === "/api/home/users") return new Response('<MediaContainer size="1"><User id="1" title="Mint member"/></MediaContainer>', { headers: { "content-type": "application/xml", "cache-control": "private, no-store" } });
    if (endpoint === "/media/providers") return json([]);
    if (endpoint === "/api/v2/user/privacy.json") return json({ optOutPlayback: true, optOutLibraryStats: true });
    return json({ error: "This cloud feature is not available in Mint" }, 404);
  }
  if (parts[0] !== "server") return json({ error: "Unknown player endpoint" }, 404);
  const library = { id: "1", key: "/library/sections/1", type: "artist", title: "Mint music", agent: "tv.plex.agents.music", scanner: "Plex Music",
    uuid: "mint-library", language: "en", allowSync: false, updatedAt: 1 };
  const provider = { identifier: "com.plexapp.plugins.library", Feature: [{ type: "content", key: "/library/sections", Directory: [library] }] };
  if (endpoint === "/" || endpoint === "/identity" || endpoint === "/media/providers") return json({
    MediaContainer: { machineIdentifier: "mint", version: "1.42.0", friendlyName: "Mint", MediaProvider: [provider] },
  });
  if (endpoint === "/library/sections") return json({ MediaContainer: { size: 1, Directory: [library] } });
  if (endpoint === "/library/sections/1") return json({ MediaContainer: { size: 1, Directory: [
    { key: "all?type=8", title: "Artists", type: "artist" }, { key: "all?type=9", title: "Albums", type: "album" },
    { key: "all?type=10", title: "Tracks", type: "track" },
  ] } });
  if (endpoint === "/library/sections/1/collections" || endpoint === "/library/sections/1/stations") return json({ MediaContainer: { size: 0, Metadata: [] } });
  if (endpoint === "/:/eventsource/notifications") return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  if (endpoint === "/photo/:/transcode") {
    const target = url.searchParams.get("url");
    if (!target || target === "undefined" || target === "null") return Response.redirect(`${publicUrl()}/listen/assets/cover.svg`, 307);
    let image: URL;
    try { image = new URL(target); } catch { return json({ error: "Invalid artwork URL" }, 400); }
    const allowed = image.protocol === "https:" && (
      image.hostname === "coverartarchive.org" || image.hostname === "archive.org" || image.hostname.endsWith(".archive.org") ||
      image.hostname === "i.ytimg.com" || image.hostname.endsWith(".ggpht.com") || image.hostname.endsWith(".googleusercontent.com"));
    if (!allowed && target !== `${publicUrl()}/listen/assets/cover.svg`) return json({ error: "Unsupported artwork source" }, 400);
    const headers = new Headers({ location: image.href, "cache-control": "private, no-store" });
    return new Response(null, { status: 307, headers });
  }
  for (const name of ["X-Plex-Container-Start", "X-Plex-Container-Size"]) {
    const value = request.headers.get(name);
    if (value) url.searchParams.set(name, value);
  }
  try {
    const result = await catalogResponse(endpoint, url.searchParams, user.id);
    return result ? json(result) : json({ error: "This Plexamp feature is not supported by the browser MVP" }, 404);
  } catch (error) {
    console.error("Player catalog failed", error instanceof Error ? error.message : "Invalid catalog request");
    return json({ error: error instanceof CatalogInputError ? error.message : "The music catalog is unavailable. Try again shortly." }, error instanceof CatalogInputError ? 400 : 503);
  }
}

export const HEAD = GET;

export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const parts = (await context.params).path;
  if (parts.length !== 1 || parts[0] !== "logout") return json({ error: "This action is not supported by the browser player" }, 405);
  if (request.headers.get("origin") !== new URL(publicUrl()).origin) return json({ error: "Invalid request origin" }, 403);
  if (!await getUser()) return json({ error: "Sign in required" }, 401);
  await destroySession();
  return json({ signedOut: true });
}
