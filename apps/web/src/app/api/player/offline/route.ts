import { signToken } from "@mint/core/crypto";
import { getSessionHash, getUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export async function GET() {
  const user = await getUser();
  const sessionHash = await getSessionHash();
  const headers = { "cache-control": "private, no-store" };
  if (!user || !sessionHash) return Response.json({ error: "Approved membership required" }, { status: 401, headers });
  const expiresAt = Date.now() + 7 * 86400_000;
  return Response.json({
    memberId: user.id, expiresAt,
    token: signToken("offline", { memberId: user.id, sessionHash, expiresAt }, 7 * 86400_000),
  }, { headers });
}
