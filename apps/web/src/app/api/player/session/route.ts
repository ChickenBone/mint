import { getUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export async function GET() {
  const user = await getUser();
  return Response.json(user ? { memberId: user.id } : { error: "Playback access has expired. Sign in again." }, {
    status: user ? 200 : 401, headers: { "cache-control": "private, no-store" },
  });
}
