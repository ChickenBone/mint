import { libraryListInputSchema } from "@mint/contracts";
import { targetApi, targetFailure, TargetRequestError, targetResponse } from "@/lib/target-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { sdk, signal } = targetApi(request);
    const parameters = new URL(request.url).searchParams;
    const values: Record<string, string | number> = {};
    for (const [name, value] of parameters) {
      if (!["limit", "search", "cursor"].includes(name) || Object.hasOwn(values, name)) {
        throw new TargetRequestError("Invalid library query.", 400);
      }
      if (name === "limit" && !/^[1-9][0-9]{0,2}$/.test(value)) {
        throw new TargetRequestError("Invalid library query.", 400);
      }
      values[name] = name === "limit" ? Number(value) : value;
    }
    const input = libraryListInputSchema.safeParse(values);
    if (!input.success) throw new TargetRequestError("Invalid library query.", 400);
    if (!await sdk.accounts.session({ signal })) throw new TargetRequestError("Unauthorized.", 401);
    // The API independently checks current active membership before listing persisted verified files.
    return targetResponse(await sdk.library.listFiles(input.data, { signal }));
  } catch (error) {
    return targetFailure(error);
  }
}
