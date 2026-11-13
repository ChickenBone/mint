import { setMemberStatusInputSchema } from "@mint/contracts";
import { boundedJson, RequestInputError } from "@/lib/request";
import { targetApi, targetFailure, TargetRequestError, targetResponse } from "@/lib/target-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { sdk, signal } = targetApi(request, true);
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      throw new TargetRequestError("Send a JSON request.", 415);
    }
    let body: unknown;
    try {
      body = await boundedJson(request, 1024);
    } catch (error) {
      if (error instanceof RequestInputError) throw new TargetRequestError(error.message, error.status);
      if (error instanceof SyntaxError) throw new TargetRequestError("Invalid JSON.", 400);
      throw error;
    }
    const input = setMemberStatusInputSchema.safeParse(body);
    if (!input.success) throw new TargetRequestError("Invalid member status.", 400);
    const user = await sdk.accounts.session({ signal });
    if (!user) throw new TargetRequestError("Unauthorized.", 401);
    if (user.role !== "admin") throw new TargetRequestError("Forbidden.", 403);
    // Active-admin authorization and disable/session revocation are enforced atomically by the API.
    await sdk.accounts.setMemberStatus(input.data, { signal });
    return targetResponse({ ok: true });
  } catch (error) {
    return targetFailure(error);
  }
}
