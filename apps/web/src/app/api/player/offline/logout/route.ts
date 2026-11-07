import { destroySession } from "@/lib/auth";
import { originAllowed } from "@/lib/request";

export async function POST(request: Request) {
  if (!originAllowed(request.headers.get("origin"))) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  await destroySession();
  return Response.json({ signedOut: true }, { headers: {
    "cache-control": "private, no-store", "clear-site-data": '"cache", "storage"',
  } });
}
