import { SESSION_COOKIE, sha256 } from "@mint/core/crypto";
import { getDb } from "@mint/core/db";
import { spotifyConfigured } from "@mint/core/spotify";
import { beginSpotifyOAuth } from "@mint/core/spotify-store";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { publicUrl } from "@/lib/request";

export const dynamic = "force-dynamic";
export async function GET() {
  const user = await getUser();
  if (!user) return NextResponse.redirect(`${publicUrl()}/login?next=/app/spotify`);
  if (!spotifyConfigured()) return NextResponse.redirect(`${publicUrl()}/app/spotify?error=setup`);
  if (!await rateLimit(`spotify-oauth:${user.id}`, 6, 600)) return NextResponse.redirect(`${publicUrl()}/app/spotify?error=rate`);
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!session) return NextResponse.redirect(`${publicUrl()}/login`);
  const url = await beginSpotifyOAuth(getDb(), user.id, sha256(session), `${publicUrl()}/api/oauth/spotify/callback`);
  return NextResponse.redirect(url);
}
