import { otaRequest } from "@/lib/ota-updates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => otaRequest(request, "update");
export const HEAD = GET;
