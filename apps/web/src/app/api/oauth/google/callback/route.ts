import { encrypt, safeEqual } from "@mint/core/crypto";
import { getDb, schema } from "@mint/core/db";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "@/lib/auth";
import { enqueueSync } from "@/lib/queues";
import { publicUrl } from "@/lib/request";

export const dynamic = "force-dynamic";

const YT_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  id_token?: string;
}

export async function GET(req: NextRequest) {
  const back = (q: string) => NextResponse.redirect(`${publicUrl()}/app/settings?${q}`);
  const jar = await cookies();
  const raw = jar.get("mint_oauth")?.value;
  jar.delete({ name: "mint_oauth", path: "/api/oauth/google" });

  const user = await getUser();
  if (!user) return NextResponse.redirect(`${publicUrl()}/login`);

  const params = req.nextUrl.searchParams;
  if (params.get("error")) return back("error=denied");
  const code = params.get("code");
  const state = params.get("state");
  let saved: { state: string; verifier: string; uid: string } | null = null;
  try {
    saved = raw ? JSON.parse(raw) : null;
  } catch {
    saved = null;
  }
  if (!code || !state || !saved || saved.uid !== user.id || !safeEqual(saved.state, state)) return back("error=state");

  try {
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID ?? "",
        client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
        redirect_uri: `${publicUrl()}/api/oauth/google/callback`,
        grant_type: "authorization_code",
        code_verifier: saved.verifier,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) throw new Error(`token exchange ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const tok = (await resp.json()) as TokenResponse;
    if (!tok.scope.split(" ").includes(YT_SCOPE)) return back("error=scope");

    // The id_token comes straight from Google over TLS in this exchange, so its claims can be read without re-verifying the signature.
    const claims = tok.id_token
      ? (JSON.parse(Buffer.from(tok.id_token.split(".")[1] ?? "", "base64url").toString()) as { sub: string; email?: string })
      : null;
    if (!claims?.sub) throw new Error("no id_token in response");

    const db = getDb();
    const existing = await db.query.youtubeAccounts.findFirst({ where: eq(schema.youtubeAccounts.userId, user.id) });
    const sameAccount = existing?.googleSub === claims.sub;
    if (!tok.refresh_token && !sameAccount) return back("error=refresh");

    let channelTitle: string | null = null;
    const ch = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
      headers: { authorization: `Bearer ${tok.access_token}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (ch?.ok) {
      const body = (await ch.json()) as { items?: Array<{ snippet?: { title?: string } }> };
      channelTitle = body.items?.[0]?.snippet?.title ?? null;
    }

    const values = {
      googleSub: claims.sub,
      email: claims.email ?? null,
      channelTitle,
      accessTokenEnc: encrypt(tok.access_token),
      refreshTokenEnc: tok.refresh_token ? encrypt(tok.refresh_token) : existing!.refreshTokenEnc,
      expiresAt: new Date(Date.now() + tok.expires_in * 1000),
      scope: tok.scope,
      syncStatus: "idle" as const,
      syncError: null,
    };
    await db
      .insert(schema.youtubeAccounts)
      .values({ userId: user.id, ...values })
      .onConflictDoUpdate({
        target: schema.youtubeAccounts.userId,
        // A different Google account means different likes and playlists; drop the old playlist mirror state.
        set: sameAccount ? values : { ...values, plexPlaylistKey: null, lastSyncedAt: null },
      });
    if (!sameAccount && existing) await db.delete(schema.playlists).where(eq(schema.playlists.userId, user.id));
    await enqueueSync(user.id, "linked");
    return back("linked=1");
  } catch (err) {
    console.error("[oauth] google callback failed", err);
    return back("error=failed");
  }
}
