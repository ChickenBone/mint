export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: string,
  ) {
    super(message);
  }
}

export interface RequestOpts extends Omit<RequestInit, "body"> {
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  query?: Record<string, string | number | boolean | undefined>;
}

function withQuery(url: string, query?: RequestOpts["query"]) {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
  return u.toString();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch with timeout, JSON bodies, and retry on network errors / 429 / 5xx. */
export async function http(url: string, opts: RequestOpts = {}): Promise<Response> {
  const { body, timeoutMs = 20_000, retries = 2, query, headers, ...init } = opts;
  const finalUrl = withQuery(url, query);
  const isForm = body instanceof FormData;
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(finalUrl, {
        ...init,
        headers: {
          accept: "application/json",
          ...(body !== undefined && !isForm ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
        attempt++;
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new HttpError(res.status, `${init.method ?? "GET"} ${new URL(finalUrl).pathname} -> ${res.status}`, text.slice(0, 500));
      }
      return res;
    } catch (err) {
      if (err instanceof HttpError || attempt >= retries) throw err;
      await sleep(1000 * 2 ** attempt);
      attempt++;
    }
  }
}

export async function httpJson<T>(url: string, opts: RequestOpts = {}): Promise<T> {
  const res = await http(url, opts);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
