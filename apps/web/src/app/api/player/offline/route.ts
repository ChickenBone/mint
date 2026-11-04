import { cookies } from "next/headers";
import { SESSION_COOKIE, sha256, signToken } from "@mint/core/crypto";
import { getUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export async function GET() {
  const user = await getUser();
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  const headers = { "cache-control": "private, no-store" };
  if (!user || !session) return Response.json({ error: "Approved membership required" }, { status: 401, headers });
  const expiresAt = Date.now() + 7 * 86400_000;
  return Response.json({
    memberId: user.id, expiresAt,
    token: signToken("offline", { memberId: user.id, sessionHash: sha256(session), expiresAt }, 7 * 86400_000),
  }, { headers });
}
