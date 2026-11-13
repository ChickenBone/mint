import { targetApi, targetFailure, targetResponse } from "@/lib/target-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { sdk, signal } = targetApi(request);
    return targetResponse({ user: await sdk.accounts.session({ signal }) });
  } catch (error) {
    return targetFailure(error);
  }
}
