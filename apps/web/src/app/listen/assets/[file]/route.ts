import { readFile } from "node:fs/promises";
import path from "node:path";
import { getUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ file: string }> }) {
  if (!await getUser()) return new Response("Approved membership required", { status: 401, headers: { "cache-control": "no-store" } });
  const file = (await context.params).file;
  if (file === "cover.svg") return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500" viewBox="0 0 500 500"><rect width="500" height="500" fill="#263e35"/><circle cx="250" cy="250" r="155" fill="#345849"/><circle cx="250" cy="250" r="52" fill="#8fdbb1"/></svg>',
    { headers: { "content-type": "image/svg+xml", "cache-control": "private, no-store" } });
  if (file !== "bridge.js" && file !== "index.js") return new Response("Not found", { status: 404 });
  const target = file === "bridge.js"
    ? path.resolve(/* turbopackIgnore: true */ process.env.PLEXAMP_BRIDGE_PATH ?? "../../deploy/plexamp/bridge.js")
    : path.join(/* turbopackIgnore: true */ process.env.PLEXAMP_ASSET_DIR ?? path.resolve("plexamp-assets"), file);
  try {
    return new Response(await readFile(target), { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "private, no-store" } });
  } catch (error) {
    console.error("Plexamp browser assets unavailable", error instanceof Error ? error.message : "File read failed");
    return new Response("Player assets are unavailable. Run npm run player:prepare or update the web image.", { status: 503 });
  }
}
