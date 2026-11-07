import { getDb } from "@mint/core/db";
import { getUser } from "@/lib/auth";
import { handleIssueReportPost } from "@/lib/issue-reports";
import { publicUrl } from "@/lib/request";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const user = await getUser();
  return handleIssueReportPost(request, { userId: user?.id ?? null, db: getDb, origin: publicUrl() },
    isNativeTransportRequest(request) ? () => true : undefined);
}
import { isNativeTransportRequest } from "@/lib/native-context";
