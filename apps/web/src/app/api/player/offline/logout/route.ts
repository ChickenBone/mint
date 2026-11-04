import { destroySession } from "@/lib/auth";
import { publicUrl } from "@/lib/request";

export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(publicUrl()).origin) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  await destroySession();
  return Response.json({ signedOut: true }, { headers: {
    "cache-control": "private, no-store", "clear-site-data": '"cache", "storage"',
  } });
}
