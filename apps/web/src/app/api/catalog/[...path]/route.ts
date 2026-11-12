import { catalogConnectionResponse } from "@/lib/catalog-connection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const response = await catalogConnectionResponse(request, ["catalog", ...path]);
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("vary", "Cookie");
  return response;
}
