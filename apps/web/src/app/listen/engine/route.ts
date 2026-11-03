import { getUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export async function GET() {
  const user = await getUser();
  if (!user) return new Response("Approved membership required", { status: 401, headers: { "cache-control": "no-store" } });
  const member = JSON.stringify({ id: user.id, name: user.name }).replace(/</g, "\\u003c");
  return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Mint music engine</title>
<link rel="stylesheet" href="/listen/assets/player.css"></head><body>
<!-- THESIS: Mint owns the listening experience; opening a song never interrupts its engine.
OWN-WORLD: Figtree, neutral dark surfaces, artwork-led hierarchy and mint actions.
STORY: Open artwork or title, manage Up next, Lyrics and Sound, then return to the originating page.
FIRST VIEWPORT: Now playing pairs a large sleeve and transport with listening tools; phones pin transport below scrolling content.
FORM: User-pinned Spotify-like Mint shell, extending the existing visual system; embedded Plexamp supplies browsing only. -->
<div id="mint-player-error" role="alert" hidden></div><div id="react-app"></div>
<script>window.mintMember=${member};window.mintEmbedded=true;if(window.parent===window)location.replace("/app/music");window.addEventListener("error",function(event){if(event.target instanceof HTMLScriptElement){var alert=document.getElementById("mint-player-error");alert.textContent="The music engine could not load. Reload Mint or ask the administrator to update the web image.";alert.hidden=false;parent.postMessage({channel:"mint-player-v2",type:"error",message:alert.textContent},location.origin)}},true)</script>
<script src="/listen/assets/audio.js"></script><script src="/listen/assets/integration.js"></script><script src="/listen/assets/bridge.js"></script><script defer src="/listen/assets/index.js"></script>
</body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } });
}
