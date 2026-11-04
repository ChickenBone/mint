import { deviceApi } from "@/lib/devices";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
export async function GET(request: Request, context: Context) {
  return deviceApi(request, (await context.params).path, "devices");
}
export const POST = GET;
