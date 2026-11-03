import { randomToken } from "@mint/core/crypto";
import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth";
import { publicUrl } from "@/lib/request";

export const dynamic = "force-dynamic";

const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/youtube.readonly"];
const OAUTH_COOKIE = "mint_oauth";

export async function GET() {
  const user = await getUser();
  if (!user) return NextResponse.redirect(`${publicUrl()}/login?next=/app/settings`);
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return NextResponse.redirect(`${publicUrl()}/app/settings?error=failed`);

  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  (await cookies()).set(OAUTH_COOKIE, JSON.stringify({ state, verifier, uid: user.id }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/oauth/google",
    maxAge: 600,
  });

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${publicUrl()}/api/oauth/google/callback`,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return NextResponse.redirect(url);
}
