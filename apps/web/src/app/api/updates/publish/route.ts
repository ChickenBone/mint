import { otaRequest } from "@/lib/ota-updates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = (request: Request) => otaRequest(request, "publish");
