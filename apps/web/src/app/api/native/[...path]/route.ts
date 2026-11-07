import { runNativeRequest } from "@/lib/native-context";
import { nativeHttp, nativeRouteAllowed } from "@/lib/native-http";
import { resolveNativeSession } from "@/lib/native-sessions";
import * as catalog from "../../player/catalog/route";
import * as audio from "../../player/audio/[id]/route";
import * as info from "../../player/info/[id]/route";
import * as lyrics from "../../player/lyrics/[id]/route";
import * as session from "../../player/session/route";
import * as offline from "../../player/offline/route";
import * as queue from "../../player/queue/[[...path]]/route";
import * as items from "../../player/items/route";
import * as music from "../../music/[...path]/route";
import * as search from "../../music/search/route";
import * as reports from "../../issue-reports/route";
import * as charts from "../../charts/route";
import { nativeBrowseResponse } from "@/lib/native-browse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
type Context = { params: Promise<{ path: string[] }> };
const json = (error: string, status: number) => Response.json({ error }, { status });

async function dispatch(request: Request, path: string[]) {
  const key = path.join("/");
  const id = { params: Promise.resolve({ id: path[2]! }) };
  if (key === "player/catalog") return catalog.GET(request);
  if (key === "player/session") return session.GET();
  if (key === "player/offline") return offline.GET();
  if (key === "player/items") return items.POST(request);
  if (path[0] === "player" && path[1] === "audio") return audio.GET(request, id);
  if (path[0] === "player" && path[1] === "info") return info.GET(request, id);
  if (path[0] === "player" && path[1] === "lyrics") return lyrics.GET(request, id);
  if (path[0] === "player" && path[1] === "queue") {
    return queue.GET(request, { params: Promise.resolve({ path: path.slice(2) }) });
  }
  if (key === "music/search") return search.GET(request);
  if (key === "issue-reports") return reports.POST(request);
  if (key === "browse") return nativeBrowseResponse(request);
  if (key === "charts") {
    if (process.env.MINT_CHARTS_ENABLED === "false" && !new URL(request.url).searchParams.has("chart")) return Response.json({ charts: [] });
    return charts.GET(request);
  }
  return music.GET(request, { params: Promise.resolve({ path: path.slice(1) }) });
}

async function handle(request: Request, context: Context) {
  return nativeHttp(request, async () => {
    const { path } = await context.params;
    if (!nativeRouteAllowed(path, request.method)) return json("Native consumer route not found.", 404);
    try {
      const session = await resolveNativeSession(request);
      if (!session) return json("Playback access has expired. Sign in again.", 401);
      return await runNativeRequest({ user: session.user, sessionHash: session.sessionHash, request },
        () => dispatch(request, path));
    } catch (error) {
      console.error("[native-api] request failed", error instanceof Error ? error.name : "Unknown failure");
      return json("The server could not complete this request. Try again later.", 503);
    }
  });
}
export { handle as GET, handle as HEAD, handle as POST, handle as PATCH, handle as PUT, handle as DELETE };
export const OPTIONS = (request: Request) => nativeHttp(request, async () => json("Method not allowed.", 405));
