import { NextResponse, type NextRequest } from "next/server";
import { searchLibrary } from "@/lib/data";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/request";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await rateLimit(`library:${await clientIp()}`, 120, 60))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "60" } });
  }
  const q = req.nextUrl.searchParams.get("q") ?? undefined;
  const cursor = req.nextUrl.searchParams.get("cursor");
  try {
    return NextResponse.json(await searchLibrary({ q, cursor, limit: 50 }));
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
}
