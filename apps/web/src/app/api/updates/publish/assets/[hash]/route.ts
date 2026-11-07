import { otaRequest } from "@/lib/ota-updates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ hash: string }> };
export async function PUT(request: Request, context: Context) {
  return otaRequest(request, "upload", (await context.params).hash);
}
