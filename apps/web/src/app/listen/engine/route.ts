import { getUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export async function GET() {
  const user = await getUser();
  if (!user) return new Response("Approved membership required", { status: 401, headers: { "cache-control": "no-store" } });
  const member = JSON.stringify({ id: user.id, name: user.name }).replace(/</g, "\\u003c");
  return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Mint music engine</title>
<link rel="stylesheet" href="/listen/assets/player.css"></head><body>
<!-- THESIS: One Mint workspace, uninterrupted music. OWN-WORLD: Figtree, warm dark surfaces, mint actions.
STORY: Browse, queue and manage the library without leaving playback. FIRST VIEWPORT: Mint owns navigation and transport; Plexamp owns the music canvas.
FORM: User-pinned Spotify-like persistent shell, extending Mint's existing design. -->
<div id="mint-player-error" role="alert" hidden></div><div id="react-app"></div>
<script>window.mintMember=${member};window.mintEmbedded=true;if(window.parent===window)location.replace("/app/music");window.addEventListener("error",function(event){if(event.target instanceof HTMLScriptElement){var alert=document.getElementById("mint-player-error");alert.textContent="The music engine could not load. Reload Mint or ask the administrator to update the web image.";alert.hidden=false;parent.postMessage({channel:"mint-player-v2",type:"error",message:alert.textContent},location.origin)}},true)</script>
<script src="/listen/assets/audio.js"></script><script src="/listen/assets/integration.js"></script><script src="/listen/assets/bridge.js"></script><script defer src="/listen/assets/index.js"></script>
</body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } });
}
