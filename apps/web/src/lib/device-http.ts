export function validDeviceOrigin(request: Request, origin: string) {
  const supplied = request.headers.get("origin");
  return supplied === new URL(origin).origin && request.headers.get("sec-fetch-site") !== "cross-site";
}
