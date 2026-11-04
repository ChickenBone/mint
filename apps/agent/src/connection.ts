export function mintUrl(value: string) {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("MINT_URL must be an absolute HTTP(S) URL, for example https://mint.chickenbone.dev"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("MINT_URL must be an HTTP(S) origin without credentials, path, query or fragment");
  }
  return url.origin;
}

export function loopbackUrl(value: string) {
  return ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(new URL(value).hostname);
}

export function connectionFailure(error: unknown) {
  const reason = error instanceof Error ? error.message : "Unknown connection failure";
  const cause = error instanceof Error && error.cause && typeof error.cause === "object" && "code" in error.cause
    ? String(error.cause.code).slice(0, 80) : undefined;
  return { error: reason, ...(cause ? { code: cause } : {}) };
}
