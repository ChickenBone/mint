import { deviceApi } from "@/lib/devices";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => deviceApi(request, [], "devices");
export const POST = GET;
