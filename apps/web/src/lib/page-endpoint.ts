const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

export function isLoopbackHost(hostname: string) {
  return LOOPBACK.has(hostname.replace(/^\[|\]$/g, ""));
}

/** A loopback dev URL follows the host the page was opened on. Other URLs stay put. */
export function endpointOnPage(configured: string, page: { protocol: string; hostname: string }) {
  const url = new URL(configured);
  if (!isLoopbackHost(url.hostname) || isLoopbackHost(page.hostname)) return configured;
  url.hostname = page.hostname;
  if (url.protocol === "ws:" || url.protocol === "wss:") url.protocol = page.protocol === "https:" ? "wss:" : "ws:";
  else if (url.protocol === "http:" || url.protocol === "https:") url.protocol = page.protocol === "https:" ? "https:" : "http:";
  return url.toString().replace(/\/$/, "");
}
