import { nativeBearer, nativeLoginSchema } from "@mint/client/auth";
import { authenticateAccount } from "@/lib/account-login";
import { createNativeSession, resolveNativeSession, revokeNativeSession } from "@/lib/native-sessions";
import { boundedJson, clientIp, RequestInputError } from "@/lib/request";
import { z } from "zod";
import { nativeHttp } from "@/lib/native-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { "cache-control": "private, no-store", vary: "Authorization" },
});
type Context = { params: Promise<{ action: string }> };

async function handle(request: Request, context: Context) {
  const { action } = await context.params;
  try {
    if (action === "login" && request.method === "POST") {
      if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "Send a JSON request." }, 415);
      const input = nativeLoginSchema.parse(await boundedJson(request, 4096));
      const result = await authenticateAccount(input.email, input.password, await clientIp());
      if ("error" in result) return json({ error: result.error }, result.status);
      const user = { id: result.user.id, name: result.user.name, email: result.user.email };
      return json({ user, ...await createNativeSession(user.id, input.deviceId, input.deviceName, await clientIp()) }, 201);
    }
    if (action === "logout" && request.method === "POST") {
      if (!nativeBearer(request.headers)) return json({ error: "Send a native account credential." }, 401);
      await revokeNativeSession(request);
      return json({ ok: true });
    }
    if (action === "session" && request.method === "GET") {
      const session = await resolveNativeSession(request);
      if (!session) return json({ error: "Playback access has expired. Sign in again." }, 401);
      return json({ user: { id: session.user.id, name: session.user.name, email: session.user.email },
        deviceId: session.deviceId, expiresAt: session.expiresAt });
    }
    return json({ error: "Native account route not found." }, 404);
  } catch (error) {
    if (error instanceof RequestInputError) return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return json({ error: "Check your account and device details." }, 400);
    console.error("[native-auth] request failed", error instanceof Error ? error.name : "Unknown failure");
    return json({ error: "The server could not complete sign-in. Try again later." }, 503);
  }
}
const transport = (request: Request, context: Context) => nativeHttp(request, () => handle(request, context));
export { transport as GET, transport as POST };
export const OPTIONS = (request: Request) => nativeHttp(request, async () => json({ error: "Method not allowed." }, 405));
