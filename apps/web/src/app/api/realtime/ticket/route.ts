import { SESSION_COOKIE, sha256, signToken } from "@mint/core/crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth";

/**
 * Short-lived proof of session for the WebSocket gateway, which lives on another host
 * (ws.mint…) and can't read the host-only session cookie. Visitors get no ticket.
 */
export async function GET() {
  const user = await getUser();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const ticket = user && token ? signToken("ws", { sid: sha256(token) }, 60_000) : null;
  return NextResponse.json({ ticket }, { headers: { "cache-control": "no-store, private" } });
}
