import { SESSION_COOKIE, sha256 } from "@mint/core/crypto";
import { getDb } from "@mint/core/db";
import { connectSpotifyAccount, consumeSpotifyState } from "@mint/core/spotify-store";
import { SpotifyError } from "@mint/core/spotify";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "@/lib/auth";
import { publicUrl } from "@/lib/request";
import { enqueueSpotifySync } from "@/lib/spotify-queue";

export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const back = (error?: string) => NextResponse.redirect(`${publicUrl()}/app/spotify?${error ? `error=${error}` : "linked=1"}`);
  const user = await getUser(), session = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!user || !session) return NextResponse.redirect(`${publicUrl()}/login`);
  const params = request.nextUrl.searchParams;
  const verifier = await consumeSpotifyState(getDb(), user.id, sha256(session), params.get("state") ?? "");
  if (!verifier) return back("state");
  if (params.get("error")) return back("denied");
  const code = params.get("code");
  if (!code || code.length > 10_000) return back("state");
  try {
    await connectSpotifyAccount(getDb(), user.id, code, verifier, `${publicUrl()}/api/oauth/spotify/callback`);
  } catch (error) {
    // Log only a classification, never OAuth tokens, codes, URLs, or provider bodies.
    console.warn("[spotify] account linking failed", error instanceof SpotifyError ? error.status : "contract");
    return back(error instanceof SpotifyError && error.status === 403 ? "access" : "failed");
  }
  try { await enqueueSpotifySync(user.id); } catch { return back("queue"); }
  return back();
}
