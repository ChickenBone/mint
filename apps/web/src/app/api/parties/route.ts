import { deviceApi } from "@/lib/devices";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => deviceApi(request, [], "parties");
export const POST = GET;
