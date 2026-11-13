import { decideAccessRequestInputSchema } from "@mint/contracts";
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
    const input = decideAccessRequestInputSchema.safeParse(body);
    if (!input.success) throw new TargetRequestError("Invalid access-request decision.", 400);
    const user = await sdk.accounts.session({ signal });
    if (!user) throw new TargetRequestError("Unauthorized.", 401);
    if (user.role !== "admin") throw new TargetRequestError("Forbidden.", 403);
    // The API resolves the session again and enforces active-admin policy at mutation time.
    await sdk.accounts.decideAccessRequest(input.data, { signal });
    return targetResponse({ ok: true });
  } catch (error) {
    return targetFailure(error);
  }
}
