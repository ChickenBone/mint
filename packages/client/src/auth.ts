import { z } from "zod";

export const nativeTokenSchema = z.string().regex(/^mn1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
export const nativeLoginSchema = z.object({
  email: z.email().max(200),
  password: z.string().min(1).max(200),
  deviceId: z.uuid(),
  deviceName: z.string().trim().min(1).max(80),
});
export type NativeLogin = z.infer<typeof nativeLoginSchema>;
export const accountSchema = z.object({ id: z.uuid(), name: z.string(), email: z.email() });
export type Account = z.infer<typeof accountSchema>;
export const nativeSessionSchema = z.object({
  user: accountSchema,
  deviceId: z.uuid(),
  expiresAt: z.iso.datetime(),
});
export const nativeCredentialSchema = nativeSessionSchema.extend({ token: nativeTokenSchema })
  .refine((credential) => credential.token.split(".")[1] === credential.deviceId, "Native credential installation does not match.");
export type NativeCredential = z.infer<typeof nativeCredentialSchema>;

export function nativeBearer(headers: Headers): string | null {
  const match = /^Bearer (.+)$/i.exec(headers.get("authorization") ?? "");
  const parsed = nativeTokenSchema.safeParse(match?.[1]);
  return parsed.success ? parsed.data : null;
}

export function normalizeServerUrl(value: string, allowDevelopmentHttp = false): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error("Enter your server's full HTTPS address."); }
  if (url.username || url.password || url.search || url.hash || url.pathname.replace(/\/+$/, "")) {
    throw new Error("Use the server address without a path, credentials, query or fragment.");
  }

  if (url.protocol !== "https:" && !(allowDevelopmentHttp && url.protocol === "http:")) {
    throw new Error("Use HTTPS to protect your account and music connection.");
  }
  return url.origin;
}

export function connectionErrorMessage() {
  const origin = typeof location === "object" ? location.origin : undefined;
  return origin && origin !== "null"
    ? `Could not connect to your server. For Expo web, deploy the native API routes and allow NATIVE_WEB_ORIGINS=${origin} on the server, then restart or redeploy it. Also check the address and connection.`
    : "Could not connect to your server. Check the address and your connection.";
}
