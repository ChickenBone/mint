import { otaRequest } from "@/lib/ota-updates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ hash: string }> };
export async function GET(request: Request, context: Context) {
  return otaRequest(request, "asset", (await context.params).hash);
}
export const HEAD = GET;
