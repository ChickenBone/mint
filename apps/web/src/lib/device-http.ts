export function validDeviceOrigin(request: Request, origin: string | readonly string[]) {
  const allowed = new Set((Array.isArray(origin) ? origin : [origin]).map((value) => new URL(value).origin));
  const supplied = request.headers.get("origin");
  return Boolean(supplied && allowed.has(supplied) && request.headers.get("sec-fetch-site") !== "cross-site");
}
