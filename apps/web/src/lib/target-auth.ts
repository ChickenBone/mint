import "server-only";
import { headers } from "next/headers";
import { targetApi } from "./target-api";
import { TrustedIngressError } from "./trusted-ingress";

export function targetAuthenticationEnabled(): boolean {
  return ["MINT_TARGET_API_URL", "MINT_TARGET_GATEWAY_TOKEN", "MINT_TARGET_WEB_ORIGIN",
    "MINT_TARGET_TRUSTED_PROXY", "MINT_TARGET_INGRESS_TOKEN"]
    .some((key) => process.env[key] !== undefined);
}

export async function targetAuthentication(mutation = false, publicAuthentication = false) {
  const requestHeaders = new Headers(await headers());
  return targetApi(new Request("http://mint.invalid/", { headers: requestHeaders }), mutation, publicAuthentication);
}

export function authenticationFailure(error: unknown): { error: string } {
  // Never log upstream errors, connection settings, submitted credentials or headers.
  console.error(error instanceof TrustedIngressError ? "TargetAuthIngressError" : "TargetAuthRequestError");
  return { error: "Sign-in and access requests are unavailable. Try again later." };
}
