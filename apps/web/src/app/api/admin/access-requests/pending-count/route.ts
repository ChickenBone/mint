import { targetApi, targetFailure, TargetRequestError, targetResponse } from "@/lib/target-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { sdk, signal } = targetApi(request);
    const user = await sdk.accounts.session({ signal });
    if (!user) throw new TargetRequestError("Unauthorized.", 401);
    if (user.role !== "admin" || user.status !== "active") throw new TargetRequestError("Forbidden.", 403);
    // The count query independently checks the fresh persisted active-admin session.
    return targetResponse(await sdk.accounts.pendingAccessRequestCount({ signal }));
  } catch (error) {
    return targetFailure(error);
  }
}
