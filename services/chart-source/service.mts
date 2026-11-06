import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CHARTS } from "../../apps/web/src/lib/charts";
import { cachedChart, type ChartCacheStore } from "../../apps/web/src/lib/chart-cache";
import { fetchChart } from "../../apps/web/src/lib/chart-providers";

export interface ChartSourceOptions {
  store: ChartCacheStore;
  enabled?: boolean;
  ready?: () => Promise<boolean>;
  load?: typeof fetchChart;
  now?: () => number;
}

export function createChartSourceServer(options: ChartSourceOptions) {
  const now = options.now ?? Date.now;
  const clients = new Map<string, { count: number; until: number }>();
  let active = 0;
  const reply = (response: ServerResponse, status: number, body: unknown, retrySeconds?: number) => {
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(retrySeconds ? { "retry-after": String(retrySeconds) } : {}),
    });
    response.end(JSON.stringify(body));
  };
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "GET") {
      response.setHeader("allow", "GET");
      return reply(response, 405, { error: "Only GET is supported." });
    }
    if (request.headers["transfer-encoding"] || Number(request.headers["content-length"] ?? 0) !== 0)
      return reply(response, 400, { error: "Request bodies are not supported." });
    const url = new URL(request.url ?? "/", "http://chart-source.invalid");
    const time = now(), address = request.socket.remoteAddress ?? "unknown";
    for (const [key, value] of clients) if (value.until <= time) clients.delete(key);
    const client = clients.get(address) ?? { count: 0, until: time + 60_000 };
    if (!clients.has(address) && clients.size >= 10_000)
      return reply(response, 503, { error: "Request capacity reached. Retry later." }, 60);
    clients.set(address, client);
    if (++client.count > 120)
      return reply(response, 429, { error: "Request rate limit reached." }, Math.max(1, Math.ceil((client.until - time) / 1000)));
    if (url.pathname === "/healthz" && !url.search) {
      const ready = await (options.ready?.() ?? Promise.resolve(true));
      return reply(response, ready ? 200 : 503, { status: ready ? "ok" : "unavailable" });
    }
    if (url.pathname === "/v1/charts" && !url.search) return reply(response, 200, { charts: CHARTS });
    const match = /^\/v1\/charts\/([a-z0-9-]+)$/.exec(url.pathname);
    const chart = match && CHARTS.find((item) => item.id === match[1]);
    if (!chart) return reply(response, 404, { error: "Chart not found." });
    const limits = url.searchParams.getAll("limit");
    if ([...url.searchParams.keys()].some((key) => key !== "limit") || limits.length > 1 ||
      (limits.length && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(limits[0]!)))
      return reply(response, 400, { error: "Only limit=1..50 is supported. No upstream URL or source selection is accepted." });
    const limit = Number(limits[0] ?? 50);
    let cached;
    if (options.enabled === false) cached = { snapshot: null, status: "error", retryAt: null, notice: "Charts are disabled on the chart source service." } as const;
    else {
      try { cached = await cachedChart(chart, options.store, options.load ?? fetchChart, time); }
      catch {
        cached = { snapshot: null, status: "error", retryAt: null, notice: "The chart source cache is unavailable. Check Redis connectivity." } as const;
      }
    }
    const retry = cached.retryAt ? Math.max(1, Math.ceil((Date.parse(cached.retryAt) - time) / 1000)) : undefined;
    return reply(response, cached.snapshot ? 200 : 503, {
      chart, ...cached, snapshot: cached.snapshot ? { ...cached.snapshot, entries: cached.snapshot.entries.slice(0, limit) } : null,
    }, retry);
  };
  const server = createServer((request, response) => {
    request.resume();
    if (active >= 32) return reply(response, 503, { error: "Request capacity reached. Retry later." }, 10);
    active++;
    void handle(request, response).catch(() => {
      if (!response.headersSent) reply(response, 503, { error: "The chart source is unavailable. Retry later." }, 60);
      else response.end();
    }).finally(() => { active--; });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 30;
  server.maxRequestsPerSocket = 100;
  return server;
}
