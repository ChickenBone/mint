import { getUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export async function GET() {
  const user = await getUser();
  if (!user) return new Response(null, { status: 303, headers: { location: "/login", "cache-control": "no-store" } });
  const member = JSON.stringify({ id: user.id, name: user.name }).replace(/</g, "\\u003c");
  return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Listen · Mint</title>
<style>html,body{height:100%;margin:0;background:#171b20;color:#fff;font-family:system-ui}#react-app{height:calc(100% - 40px)}
#react-app>div{height:100%}#mint-bar{height:40px;display:flex;align-items:center;gap:20px;padding:0 16px;font-size:13px;background:#11161a;white-space:nowrap}
a{color:#8fdbb1}#mint-player-error{position:fixed;top:44px;left:8px;right:8px;z-index:99999;background:#612927;padding:14px;border-radius:8px}
#mint-player-error button{margin-left:16px;padding:8px 12px;color:#fff;background:transparent;border:1px solid currentColor;cursor:pointer}
a:focus-visible,button:focus-visible{outline:2px solid #8fdbb1;outline-offset:3px}
@media(max-width:600px){#mint-bar{gap:12px;padding:0 12px;font-size:12px}#mint-members-only{display:none}}
</style></head><body><header id="mint-bar"><a href="/app">← Mint</a><span>Plexamp for Mint</span><a href="plexamp://">Open Plexamp</a>
<span id="mint-members-only">Approved members only</span></header><div id="mint-player-error" role="alert" hidden></div><div id="react-app"></div>
<noscript>Browser listening requires JavaScript. Enable it and reload, or use the installed Plexamp app.</noscript>
<script>window.mintMember=${member};window.addEventListener("error",function(event){if(event.target instanceof HTMLScriptElement){var alert=document.getElementById("mint-player-error");alert.textContent="The player could not load. Return to Mint and ask the administrator to update the web image.";alert.hidden=false}},true)</script><script src="/listen/assets/bridge.js"></script><script defer src="/listen/assets/index.js"></script>
</body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } });
}
