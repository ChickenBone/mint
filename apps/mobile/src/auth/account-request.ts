import { ApiError, connectionErrorMessage } from "@mint/client";
import { z } from "zod";

export async function accountRequest<T>(serverUrl: string, action: "login" | "session" | "logout",
  schema: z.ZodType<T>, token?: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(`${serverUrl}/api/native/auth/${action}`, {
      method: action === "session" ? "GET" : "POST", credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal,
      headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(connectionErrorMessage(), 0);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new ApiError("The server returned an unexpected sign-in response.", response.status); }
  if (!response.ok) {
    const parsed = z.object({ error: z.string() }).safeParse(value);
    throw new ApiError(parsed.success ? parsed.data.error : "The server could not complete sign-in.", response.status);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError("This server's account API is incompatible. Update the app or server.", response.status);
  return parsed.data;
}
