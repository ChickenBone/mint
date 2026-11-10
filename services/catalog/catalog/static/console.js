"use strict";

const $ = (id) => document.getElementById(id);
const names = { musicbrainz: "MusicBrainz", listenbrainz: "ListenBrainz", apple: "Apple Music", youtube: "YouTube", ytmusic: "YouTube Music", spotify: "Spotify", deezer: "Deezer", audius: "Audius", archive: "Internet Archive", wikidata: "Wikidata", soundcloud: "SoundCloud", openverse: "Openverse", discogs: "Discogs", openwhyd: "Openwhyd", omdb: "Openmusic Database", amazon: "Amazon Music", catalog: "Source genre tags" };
const fmt = new Intl.NumberFormat();
const state = { snapshot: null, token: null, socket: null, paused: false, lastAt: 0, lastEvent: 0, selected: null, graph: null, graphSignature: "", reconnect: null, searchAbort: null, researchSignature: "" };
const network = { mode: "embeddings", query: "", next: null, focus: null, request: null, loading: false, overview: true, atlasPath: [null] };
const embedding = { view: null, request: null, next: null, records: new Map(), loading: false, all: false, scanned: 0, skipped: 0, projection: null, rendered: 0 };
const EMBEDDING_LIMIT = 1000000;
let storageAt = 0, storageLoading = false;
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const empty = (message) => node("p", message, "empty");
const number = (value) => fmt.format(value ?? 0);
const when = (value) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const displayKey = (key) => key.length > 64 ? `${key.slice(0, 61)}…` : key;

function replace(container, children) {
  const focus = container.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
  container.replaceChildren(...children);
  if (focus) container.querySelector(`[data-focus="${CSS.escape(focus)}"]`)?.focus({ preventScroll: true });
}

function notice(message) {
  $("notice").textContent = message;
  $("notice").hidden = !message;
}

async function request(path, options = {}) {
  const response = await fetch(path, { ...options, signal: options.signal ?? AbortSignal.timeout(15000) });
  let body;
  try { body = await response.json(); } catch { throw new Error(`Unexpected server response (${response.status}). Check container logs.`); }
  if (!response.ok) throw new Error(typeof body.detail === "string" ? body.detail : `Request failed (${response.status}). Check the submitted fields.`);
  return body;
}

async function control(path, payload) {
  if (!state.token) state.token = (await request("/v1/console/session")).token;
  return request(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Console-Token": state.token }, body: JSON.stringify(payload) });
}

function setConnection(label, connected) {
  $("connection").textContent = label;
  $("connection-dot").classList.toggle("connected", connected);
}

function connect() {
  clearTimeout(state.reconnect);
  if (state.paused || document.hidden) return;
  const socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/v1/console/live`);
  state.socket = socket;
  setConnection("Connecting", false);
  socket.addEventListener("message", (event) => {
    if (socket !== state.socket) return;
    try {
      const message = JSON.parse(event.data);
      if (message.type === "error") {
        notice(message.message);
        setConnection("Telemetry delayed", false);
        return;
      }
      if (message.type !== "snapshot") return;
      state.lastAt = message.data.at;
      setConnection("Live · 5s", true);
      notice("");
      render(message.data);
    } catch (error) {
      notice(`Unable to render telemetry: ${error.message}. Refresh this page.`);
      setConnection("Display error", false);
    }
  });
  socket.addEventListener("close", () => {
    if (socket !== state.socket) return;
    setConnection(state.paused ? "View paused" : "Reconnecting", false);
    if (!state.paused && !document.hidden) {
      notice("Live connection interrupted. Displaying the last snapshot; reconnecting automatically.");
      state.reconnect = setTimeout(connect, 5000);
    }
  });
  socket.addEventListener("error", () => socket.close());
}

function render(data) {
  state.snapshot = data;
  $("snapshot-age").textContent = `Snapshot received ${when(data.at * 1000)}`;
  $("entity-count").textContent = number(data.entities);
  $("indexed-count").textContent = number(data.indexed);
  $("capacity-note").textContent = `${number(data.capacity)} record safety cap`;
  $("indexed-note").textContent = `${number(Math.max(0, data.entities - data.indexed))} awaiting current vectors`;
  const queue = data.queues.jobs;
  const outbox = data.queues.vector_outbox;
  $("queue-count").textContent = number(queue.due + queue.leased);
  $("queue-note").textContent = `${number(queue.due)} due · ${number(queue.scheduled)} scheduled`;
  $("error-count").textContent = number(queue.dead + outbox.dead);
  $("error-note").textContent = `${number(data.errors.length)} recent errors / delays ↓`;
  $("discovery-state").textContent = `${number(queue.leased)} active · ${number(data.eligible)} eligible`;
  $("embedding-state").textContent = outbox.total ? `${number(outbox.leased)} active · ${number(outbox.total)} pending` : "Caught up · no pending work";
  $("search-state").textContent = `${number(data.indexed)} current vectors`;
  const crawlers = data.workers.filter((worker) => worker.role === "crawler" && worker.alive);
  const blocked = Math.max(0, queue.due - data.eligible);
  $("crawl-rate").textContent = number(data.recent.discovered);
  $("rate-note").textContent = `${number(data.recent.indexed)} indexed · retained events, not unique records`;
  $("pipeline-summary").textContent = `${crawlers.length} crawlers · ${number(outbox.total)} pending vectors`;
  $("pipeline-note").textContent = `${crawlers.length ? `${crawlers.length} crawler${crawlers.length === 1 ? "" : "s"} reporting` : "No fresh crawler heartbeat — check container logs"}. ${number(blocked)} due jobs waiting on source pause, enable flags or shared host budgets. ${number(data.recent.discovered)} record observations in the last 5 minutes. An empty embedding queue means the indexer is caught up, not stopped.`;
  $("source-count").textContent = `${data.sources.filter((source) => source.enabled).length}/${data.sources.length} enabled`;
  renderSourceOptions(data.sources);
  renderSources(data.sources);
  renderResearch(data.research);
  renderWorkers(data.workers);
  renderActivity(data.activity);
  renderBudgets(data.budgets);
  renderFailures(data.errors);
  renderPopular(data.popular);
  replace($("jobs"), data.jobs.length ? data.jobs.map((job) => {
    const row = node("div", undefined, "job-row");
    row.append(node("span", `${job.task} / ${job.state}`), node("code", job.key), node("span", `Priority ${job.priority.toFixed(2)}`));
    return row;
  }) : [empty("No ready crawl jobs. Scheduled refreshes remain in the durable queue.")]);
  if (!state.selected && network.mode === "recent") drawGraph(data.graph);
  seedHelp();
}

function gb(bytes) {
  if (bytes > 0 && bytes < 1e6) return "<0.001 GB";
  return `${(bytes / 1e9).toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 })} GB`;
}

async function loadStorage() {
  if (storageLoading) return;
  storageLoading = true;
  try {
    const data = await request("/v1/console/storage");
    const storage = data.postgres;
    storageAt = data.at;
    $("storage-age").textContent = `Storage measured ${when(data.at * 1000)}`;
    $("database-size").textContent = gb(storage.database_bytes);
    $("database-note").textContent = `${gb(storage.index_bytes)} indexes included`;
    $("storage-summary").textContent = `Tables ${gb(storage.table_bytes)} · indexes ${gb(storage.index_bytes)}`;
    const measurements = [
      ["PostgreSQL database", storage.database_bytes],
      ["Catalog tables, including TOAST", storage.table_bytes],
      ["SQL indexes", storage.index_bytes],
      ["Crawl + embedding queues", storage.queue_bytes],
    ].map(([label, bytes]) => {
      const item = node("div");
      item.append(node("strong", gb(bytes)), node("span", label));
      item.title = `${number(bytes)} bytes`;
      return item;
    });
    measurements.push(node("p", `${data.notice} ${data.qdrant.note} GB = 1,000,000,000 bytes. Measurements refresh every 30 seconds; queue sizes are already included in tables/indexes.`));
    replace($("storage-breakdown"), measurements);
  } catch (error) {
    $("database-note").textContent = storageAt ? "Last measurement · refresh failed" : "Measurement unavailable";
    $("storage-summary").textContent = `Storage unavailable: ${error.message}`;
    replace($("storage-breakdown"), [node("p", `Could not refresh storage: ${error.message}. Retrying automatically in 30 seconds.`)]);
  } finally { storageLoading = false; }
}

function renderSources(sources) {
  replace($("sources"), sources.map((source) => {
    const row = node("div", undefined, "source-row");
    const top = node("div", undefined, "source-top");
    top.append(node("span", names[source.id], "source-name"));
    const label = source.bulk_only ? "Bulk import" : !source.enabled ? "Disabled" : source.paused ? "Paused" : source.active ? "Fetching" : source.wait_seconds > 0 ? "Pacing" : "Enabled";
    top.append(node("span", label, `source-state ${!source.enabled ? "disabled" : source.paused ? "paused" : ""}`));
    const meta = node("div", undefined, "source-meta");
    meta.append(node("span", `${number(source.entities)} records`));
    if (source.enabled) {
      const button = node("button", source.paused ? "Resume" : "Pause");
      button.type = "button";
      button.dataset.focus = `source-${source.id}`;
      button.setAttribute("aria-label", `${source.paused ? "Resume" : "Pause"} ${names[source.id]}`);
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await control(`/v1/console/sources/${source.id}`, { paused: !source.paused });
          notice(`${names[source.id]} ${source.paused ? "resumed" : "paused"}. In-flight work may finish.`);
          await refresh();
        } catch (error) { notice(error.message); } finally { button.disabled = false; }
      });
      meta.append(button);
    }
    row.append(top, meta);
    if (source.enabled) row.append(node("div", `${number(source.due)} due · ${number(source.eligible)} eligible${source.wait_seconds > 0 ? ` · wait ${Math.ceil(source.wait_seconds)}s` : ""}`, "source-id"));
    if (source.id === "listenbrainz") row.append(node("div", "Weekly seeds → MusicBrainz IDs", "source-id"));
    if (source.id === "openwhyd") row.append(node("div", "Hot tracks → YouTube / SoundCloud IDs", "source-id"));
    return row;
  }));
}

function renderSourceOptions(sources) {
  const existing = $("seed-source").value;
  if ($("seed-source").dataset.loaded) return;
  $("seed-source").dataset.loaded = "true";
  replace($("seed-source"), sources.filter((source) => source.kinds.length && !source.bulk_only).map((source) => {
    const option = node("option", source.name); option.value = source.id; return option;
  }));
  $("seed-source").value = existing;
  const search = document.querySelector("#search-form select[name=source]");
  replace(search, [node("option", "All sources"), ...sources.filter((source) => source.kinds.length).map((source) => {
    const option = node("option", source.name); option.value = source.id; return option;
  })]);
  search.firstElementChild.value = "";
}

function renderResearch(sources) {
  const signature = JSON.stringify(sources);
  if (state.researchSignature === signature) return;
  state.researchSignature = signature;
  $("research-summary").textContent = `${sources.length} researched sources · access and coverage`;
  replace($("source-research"), sources.map((source) => {
    const row = node("div", undefined, "research-row");
    const link = node("a", source.name, "text-action");
    link.href = source.docs; link.target = "_blank"; link.rel = "noopener noreferrer";
    row.append(link, node("span", source.status), node("p", source.note));
    return row;
  }));
}

function renderWorkers(workers) {
  $("worker-count").textContent = `${workers.filter((worker) => worker.alive).length} reporting`;
  replace($("workers"), workers.length ? workers.map((worker) => {
    const row = node("div", undefined, "worker-row");
    row.append(node("span", undefined, `status-dot ${worker.alive ? "connected" : ""}`));
    const content = node("div", worker.role);
    content.append(node("small", `${worker.alive ? worker.state : "Heartbeat stale / stopped"} · ${when(worker.seen_at)}`));
    if (worker.job_key) content.title = worker.job_key;
    row.append(content);
    return row;
  }) : [empty("No worker heartbeats yet. Check docker compose logs.")]);
}

function renderActivity(events) {
  if (events[0]?.id === state.lastEvent) return;
  const previous = state.lastEvent;
  const nearTop = $("activity").scrollTop < 25;
  replace($("activity"), events.length ? events.map((event) => {
    const row = node("li", undefined, `event ${event.action} ${previous && event.id > previous ? "new" : ""}`);
    const timestamp = node("time", when(event.occurred_at));
    timestamp.dateTime = event.occurred_at;
    row.append(timestamp, node("strong", `${event.source ? names[event.source] : event.role} / ${event.action}`), node("p", event.detail));
    if (event.key) row.title = event.key;
    return row;
  }) : [empty("No completed work yet. Source fetches, indexing and control actions appear here.")]);
  if (nearTop) $("activity").scrollTop = 0;
  state.lastEvent = events[0]?.id ?? 0;
}

function renderBudgets(budgets) {
  replace($("budgets"), budgets.length ? budgets.map((budget) => {
    const row = node("div", undefined, "budget-row");
    const waiting = budget.wait_seconds === null || Number(budget.wait_seconds) > 0;
    row.append(node("strong", budget.host), node("span", budget.wait_seconds === null ? "Quarantined" : waiting ? `Wait ${Math.ceil(budget.wait_seconds)}s` : "Available", waiting ? "waiting" : ""));
    row.title = `Next allowed request: ${budget.next_at}`;
    return row;
  }) : [empty("No upstream requests observed. Budgets appear after the first request.")]);
}

function renderFailures(errors) {
  replace($("failures"), errors.length ? errors.map((error) => {
    const row = node("div", undefined, "failure");
    row.append(node("strong", `${error.dead ? "Dead letter" : "Retry / backoff"} · ${error.source ? names[error.source] : error.queue}`), node("p", `${error.last_error} · ${error.attempts} failures`), node("p", displayKey(error.key)));
    const button = node("button", "Retry this job");
    button.type = "button";
    button.dataset.focus = `retry-${error.key}`;
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await control("/v1/console/retry", { queue: error.queue, key: error.key });
        notice("Job queued for retry. Source pause and upstream budgets still apply.");
        await refresh();
      } catch (failure) { notice(failure.message); } finally { button.disabled = false; }
    });
    row.append(button);
    return row;
  }) : [empty("Nothing needs attention. Source errors and dead letters will appear here.")]);
}

function renderPopular(records) {
  replace($("popular"), records.length ? records.map((record) => {
    const row = node("button", undefined, "popular-row");
    row.type = "button";
    row.dataset.focus = `popular-${record.key}`;
    row.append(node("strong", record.title), node("span", record.popularity.toFixed(3)));
    row.addEventListener("click", () => inspect(record.key));
    return row;
  }) : [empty("Waiting for chart ranks or public view observations.")]);
}

function renderConnections(graph, selectedEdge = null) {
  const artists = graph.scope === "artists";
  const mixed = graph.scope === "catalog";
  const atlas = graph.scope === "atlas";
  $("network-evidence").hidden = !artists && !mixed && !atlas;
  if (!artists && !mixed && !atlas) return;
  const byKey = new Map(graph.nodes.map((record) => [record.key, record]));
  const edges = selectedEdge ? [selectedEdge] : graph.edges.filter((edge) => !state.selected || edge.source === state.selected || edge.target === state.selected);
  replace($("connection-list"), edges.length ? edges.map((edge) => {
    const source = byKey.get(edge.source), target = byKey.get(edge.target);
    const row = node("div", undefined, "connection-evidence");
    const label = edge.relation === "genre" ? "tagged" : edge.relation === "album" ? "on album" : edge.relation === "artist" ? "credited to" : "↔";
    const button = node("button", `${source.title} ${label} ${target.title}`);
    button.type = "button";
    button.dataset.focus = `connection-${edge.source}-${edge.target}`;
    button.addEventListener("click", () => inspect(state.selected === edge.target ? edge.source : edge.target));
    row.append(button, node("p", atlas
      ? `${number(edge.count)} stored ${edge.relation === "genre" ? "record–tag memberships" : "relationships"} aggregated. Select a record to inspect its source attribution.`
      : `${edge.evidence_count} ${artists ? "shared credits" : "source records"} observed in the loaded sample${edge.evidence_truncated ? " · first 5 evidence records shown" : ""}.`));
    for (const record of edge.evidence || []) {
      const link = node("a", `${record.title} · ${record.kind} ↗`, "text-action");
      const url = new URL(record.url);
      if (url.protocol !== "https:") continue;
      link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer";
      row.append(link);
    }
    return row;
  }) : [empty(artists ? "No shared credits in this loaded slice. Select an artist and load more credits, or find another artist. Only stored artist records can be connected." : "No relationships for this selection in the loaded slice. Select another node or load more connections. Missing records and genre tags are never invented.")]);
}

async function loadAtlas(branch = null, path = branch ? [...network.atlasPath, branch] : [null]) {
  network.request?.abort();
  const controller = new AbortController();
  network.request = controller;
  network.loading = true;
  $("graph-scope").textContent = "Reading complete catalog groups…";
  $("graph-coverage").textContent = "Calculating coverage…";
  $("network-more").hidden = true;
  const params = new URLSearchParams(branch || {});
  try {
    const data = await request(`/v1/console/atlas?${params}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]) });
    if (network.request !== controller || network.mode !== "atlas") return;
    network.atlasPath = path;
    network.overview = !branch;
    network.next = null;
    network.focus = null;
    state.selected = null;
    $("atlas-breadcrumbs").hidden = path.length === 1;
    replace($("atlas-breadcrumbs"), path.map((entry, index) => {
      const label = entry ? `${names[entry.source] || entry.source} / ${entry.kind}${entry.prefix ? ` / ${entry.prefix}` : ""}` : "Whole catalog";
      const button = node("button", label);
      button.type = "button";
      if (index === path.length - 1) button.setAttribute("aria-current", "location");
      button.addEventListener("click", () => loadAtlas(entry, path.slice(0, index + 1)));
      return button;
    }));
    drawGraph(data);
    const detail = branch ? `${number(data.represented)} ${data.unit} in this branch` : `${number(data.total_records)} records · whole catalog`;
    $("graph-scope").textContent = detail;
    $("graph-coverage").textContent = `${branch ? "Complete branch" : "Every record represented"} · measured ${when(data.at * 1000)}`;
    $("network-notice").textContent = `${data.notice}${data.unresolved_links ? ` ${number(data.unresolved_links)} links still point to unfetched records.` : ""}`;
  } catch (error) {
    if (controller.signal.aborted) return;
    $("graph-scope").textContent = `Catalog overview unavailable: ${error.message}`;
    $("graph-coverage").textContent = "Last graph retained · use Overview to retry";
    $("network-notice").textContent = "Could not load catalog groups. The last graph is retained; select Overview to retry.";
  } finally {
    if (network.request === controller) network.loading = false;
  }
}

function setNetworkSurface() {
  const active = network.mode === "embeddings";
  document.querySelector(".map-panel").classList.toggle("embedding-active", active);
  if (!active) document.querySelector(".map-panel").classList.remove("embedding-unavailable");
  $("network").hidden = active;
  $("embedding-map").hidden = !active;
  $("embedding-controls").hidden = !active;
  $("artist-search").hidden = active || network.mode === "recent";
  $("network-overview").textContent = active ? "Reload projection" : "Overview";
  $("network-more").hidden = active || network.mode === "atlas";
  $("genre-legend").hidden = active;
  $("graph-help").textContent = active
    ? "Drag to pan; scroll or pinch to zoom. Click a point to inspect original metadata and source genre tags. Filter loaded records by name, artist or source and use the record picker for keyboard inspection. Focus the map for arrow-key pan, +/− zoom and 0 to fit. Proximity is a lossy metadata projection, not a relationship, identity match or audio similarity. Use Whole catalog groups to include records awaiting indexing and genre hubs."
    : "Zoom into or select a group to reveal its records. Drag nodes to arrange; drag the background to pan. Scroll or pinch to zoom. Use the record picker for keyboard inspection; focus the graph for arrow-key pan, +/− zoom, 0 to fit, Esc to clear selection. Groups partition stored records, not musical similarity.";
  if (!active) {
    embedding.request?.abort();
    $("graph-failure").hidden = !relationshipFailure;
    $("graph-failure").textContent = relationshipFailure;
  }
  embedding.view?.resizeView();
}

function embeddingPicker() {
  const query = $("embedding-query").value.trim().toLocaleLowerCase();
  const options = [node("option", "Select a loaded record...")];
  options[0].value = "";
  let matches = 0;
  for (const row of embedding.records.values()) {
    if (query && !`${row.title} ${row.artist} ${row.source}`.toLocaleLowerCase().includes(query)) continue;
    matches++;
    if (options.length > 200) continue;
    const option = node("option", `${row.title}${row.artist ? ` / ${row.artist}` : ""} · ${names[row.source] || row.source} / ${row.kind}`);
    option.value = row.key;
    options.push(option);
  }
  replace($("graph-record"), options);
  $("graph-record").value = state.selected || "";
  $("embedding-progress").textContent = `${number(embedding.records.size)} points loaded · ${number(embedding.scanned)} vectors scanned · ${number(embedding.skipped)} stale or missing records omitted. ${number(matches)} picker matches${matches > 200 ? " (first 200 shown; refine the filter)" : ""}.`;
}

async function loadEmbeddings({ append = false } = {}) {
  if (embedding.loading && !embedding.request?.signal.aborted) return;
  if (append && !embedding.next) return;
  embedding.loading = true;
  embedding.request?.abort();
  const controller = new AbortController();
  embedding.request = controller;
  network.overview = false;
  $("embedding-more").disabled = true;
  $("embedding-all").disabled = true;
  $("graph-scope").textContent = append ? "Loading the next vector page..." : "Projecting current metadata embeddings...";
  $("graph-failure").hidden = true;
  if (!append) {
    document.querySelector(".map-panel").classList.remove("embedding-unavailable");
    embedding.records.clear();
    embedding.scanned = 0;
    embedding.skipped = 0;
    embedding.next = null;
    embedding.projection = null;
    embedding.rendered = 0;
    embedding.view?.update([]);
    $("graph-empty").hidden = true;
    $("network-evidence").hidden = true;
    $("embedding-query").value = "";
  }
  try {
    const params = new URLSearchParams();
    if (append && embedding.next) params.set("after", embedding.next);
    const data = await request(`/v1/console/embedding-map?${params}`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]),
    });
    if (controller.signal.aborted || network.mode !== "embeddings") return;
    for (const row of data.records) {
      if (embedding.records.has(row.key) || embedding.records.size < EMBEDDING_LIMIT) embedding.records.set(row.key, row);
    }
    embedding.scanned += data.scanned;
    embedding.skipped += data.stale_skipped;
    embedding.next = data.next;
    embedding.projection = data.projection;
    $("embedding-progress").textContent = `${number(embedding.records.size)} loaded · ${number(embedding.scanned)} scanned · ${number(embedding.skipped)} stale or missing records omitted.`;
    $("graph-topology").textContent = `Sample PCA · ${number(data.projection.fitted_records)} fitting records · ${(data.projection.sample_variance_retained * 100).toFixed(1)}% sample variance retained`;
    $("graph-coverage").textContent = `${number(embedding.records.size)} loaded / ${number(data.catalog_indexed)} indexed / ${number(data.catalog_records)} stored · ${data.next ? "partial live view" : "end of vector scan"}`;
    $("network-notice").textContent = `${data.notice} Load indexed catalog streams additional pages on demand, up to ${number(EMBEDDING_LIMIT)} points per view. Reload starts a fresh projection; points can move.`;
    $("graph-scope").textContent = "Embedding Atlas · metadata proximity, not relationship edges";
    const renderNow = !embedding.all || !data.next || embedding.records.size >= EMBEDDING_LIMIT
      || embedding.records.size >= Math.max(2048, embedding.rendered * 2);
    if (!embedding.view) {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter?.features.has("shader-f16")) throw new Error("WebGPU with shader-f16 is unavailable. Use a current WebGPU-enabled browser on HTTPS or localhost. The loaded-record picker and relationship views remain available.");
      const { CatalogEmbeddingMap } = await import("./embedding-map.js");
      if (controller.signal.aborted || network.mode !== "embeddings") return;
      embedding.view = new CatalogEmbeddingMap($("embedding-map"), {
        inspect,
        tooltip: (row) => {
          $("graph-tooltip").hidden = !row;
          if (row) $("graph-tooltip").textContent = `${row.title}${row.artist ? ` · ${row.artist}` : ""} · ${names[row.source] || row.source} / ${row.kind}`;
        },
      });
    }
    if (renderNow) renderEmbeddingPoints();
    $("graph-count").textContent = `${number(embedding.rendered)} displayed / ${number(embedding.records.size)} loaded`;
    embedding.view.setMode($("embedding-display").value);
    $("graph-empty").hidden = embedding.records.size > 0;
    if (!embedding.records.size) {
      $("graph-empty").hidden = false;
      $("graph-empty").querySelector("h3").textContent = "No current embeddings to display";
      $("graph-empty").querySelector("p").textContent = "The indexer must publish current vectors before records appear here. Whole catalog groups includes records awaiting embeddings.";
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    embedding.all = false;
    embeddingPicker();
    $("graph-count").textContent = `${number(embedding.rendered)} displayed / ${number(embedding.records.size)} loaded`;
    $("graph-failure").hidden = false;
    $("graph-failure").textContent = `Embedding Atlas: ${error.message} Select Reload projection to retry.`;
    $("graph-scope").textContent = "Embedding view incomplete";
    if (!embedding.rendered) {
      document.querySelector(".map-panel").classList.add("embedding-unavailable");
      $("graph-empty").hidden = false;
      $("graph-empty").querySelector("h3").textContent = "Embedding map unavailable";
      $("graph-empty").querySelector("p").textContent = "Use the loaded-record picker below, or choose a relationship view above. A compatible WebGPU browser is required for Embedding Atlas.";
    }
  } finally {
    if (embedding.request === controller) {
      embedding.loading = false;
      const more = Boolean(embedding.next) && embedding.records.size < EMBEDDING_LIMIT;
      $("embedding-more").disabled = !more;
      $("embedding-all").disabled = !more;
      if (embedding.all && more && network.mode === "embeddings" && !controller.signal.aborted) {
        setTimeout(() => { if (embedding.all && network.mode === "embeddings") loadEmbeddings({ append: true }); }, 0);
      } else {
        embedding.all = false;
        $("embedding-stop").hidden = true;
      }
    }
  }
}

function renderEmbeddingPoints() {
  embedding.view?.update([...embedding.records.values()], { append: embedding.rendered > 0 });
  if (embedding.view) embedding.rendered = embedding.records.size;
  embeddingPicker();
  $("graph-count").textContent = `${number(embedding.rendered)} displayed / ${number(embedding.records.size)} loaded`;
}

async function loadNetwork({ key = null, after = "", append = false } = {}) {
  setNetworkSurface();
  if (network.mode === "embeddings") return loadEmbeddings();
  if (network.mode === "atlas") return loadAtlas();
  network.request?.abort();
  const controller = new AbortController();
  const mode = network.mode;
  const artists = mode === "artists";
  network.request = controller;
  network.loading = true;
  $("atlas-breadcrumbs").hidden = true;
  $("network-more").hidden = false;
  $("network-more").disabled = true;
  $("graph-scope").textContent = artists ? "Loading stored artist connections…" : "Loading the catalog brain…";
  const params = new URLSearchParams({ q: network.query });
  if (key) params.set("key", key);
  if (after) params.set("after", after);
  try {
    const data = await request(`/v1/console/${artists ? "artist" : "catalog"}-network?${params}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
    if (network.request !== controller || network.mode !== mode) return;
    network.next = data.next;
    network.focus = key;
    network.overview = !append && !key && !after;
    const graph = append && state.graph?.scope === data.scope ? CatalogGraph.merge(state.graph, data) : data;
    if (key) {
      const focused = data.nodes.find((record) => record.key === data.focus);
      state.selected = graph.nodes.find((record) => record.key === data.focus || (focused?.canonical_id && record.canonical_id === focused.canonical_id))?.key || data.focus;
    }
    drawGraph(graph);
    $("graph-coverage").textContent = "Expandable record slice · not whole catalog";
    $("graph-scope").textContent = artists
      ? key ? "Artist neighborhood · select a connection to explore further" : "Catalog artist page · select an artist to expand its neighborhood"
      : key ? "Connected catalog neighborhood · select any node to keep exploring" : "Artists, genres, songs and albums · select a node to grow the network";
    $("network-notice").textContent = `${data.notice} ${graph.view_full || data.limits.view_capacity ? "View full (180 nodes / 400 links). Start a new overview or find a specific record." : data.truncated ? artists ? `Partial view. Browse Next artists or select an artist for More credits.${data.limits.record_artists ? " First 20 peers per credited record shown." : ""}` : "Partial view. Browse Next catalog page, or select a node for more connections." : "Loaded slice shown, not the whole catalog."}`;
    $("network-more").textContent = key ? artists ? "More credits" : "More connections" : artists ? "Next artists" : "Next catalog page";
    $("network-more").disabled = !data.next || Boolean(graph.view_full);
  } catch (error) {
    if (controller.signal.aborted) return;
    $("graph-scope").textContent = `Network unavailable: ${error.message}`;
    $("network-notice").textContent = "The last graph is retained. Use Overview to retry, or select Recent records.";
    $("network-more").disabled = !network.next;
  } finally {
    if (network.request === controller) network.loading = false;
  }
}

function drawGraph(graph) {
  $("graph-tooltip").hidden = true;
  state.graph = graph;
  const signature = JSON.stringify([graph.scope, graph.nodes.map((record) => [record.key, record.title, record.popularity, record.count]).sort((a, b) => a[0].localeCompare(b[0])), graph.edges, state.selected]);
  if (signature === state.graphSignature) return;
  state.graphSignature = signature;
  $("graph-empty").hidden = graph.nodes.length > 0;
  $("graph-empty").querySelector("h3").textContent = graph.scope === "artists" ? "No stored artists in this view" : graph.scope === "catalog" ? "No matching catalog records" : "Ready to discover";
  $("graph-empty").querySelector("p").textContent = graph.scope === "artists" ? "Find another artist or add an explicit artist seed. Connections appear when credited artist records have been fetched." : "Try another name or genre, or add an artist, album or video seed to start a new branch. Only stored metadata can be connected.";
  const currentRecord = $("graph-record").value;
  replace($("graph-record"), [node("option", "Select a record…"), ...graph.nodes.slice().sort((a, b) => a.title.localeCompare(b.title)).map((record) => {
    const option = node("option", record.group ? `${record.title} · ${number(record.count)} ${record.kind === "genre" ? "tags" : "records"}${record.context ? " · context" : ""}` : `${record.title} · ${names[record.source]} / ${record.kind}`);
    option.value = record.key; return option;
  })]);
  $("graph-record").firstElementChild.value = "";
  $("graph-record").value = state.selected || currentRecord;
  graphView?.update(graph, state.selected);
  renderConnections(graph);
}

async function inspect(key) {
  const loaded = state.graph?.nodes.find((record) => record.key === key);
  if (network.mode === "atlas" && loaded?.group) {
    return loadAtlas(loaded.group);
  }
  $("inspector").open = true;
  if (network.mode === "atlas" && key.startsWith("genre:")) {
    network.mode = "catalog";
    $("graph-view").value = "catalog";
  }
  network.request?.abort();
  const previous = state.selected;
  const previousScope = $("graph-scope").textContent;
  state.selected = key;
  if (network.mode === "embeddings") embedding.view?.select(key);
  else graphView?.select(key);
  $("graph-record").value = key;
  $("graph-scope").textContent = "Loading selected relationships…";
  try {
    if (key.startsWith("genre:") && network.mode === "catalog") {
      const genre = state.graph?.nodes.find((record) => record.key === key);
      const content = node("div");
      content.append(node("h3", genre?.title || "Genre tag"), node("p", "Genre hub derived from explicit source tags. Connections do not imply similarity or a verified genre classification."));
      replace($("entity-detail"), [content]);
      await loadNetwork({ key, append: true });
      return;
    }
    const detail = await request(`/v1/entities/${encodeURIComponent(key)}`);
    if (state.selected !== key) return;
    const record = detail.entity;
    const content = node("div");
    content.append(node("h3", record.title), node("p", `${names[record.source]} · ${record.kind} · ${record.country} · ${record.revision === record.indexed_revision ? "Indexed" : "Awaiting vectors"} · popularity ${record.popularity.toFixed(3)}`));
    if (detail.providers?.length > 1) {
      content.append(node("p", "Linked artist records · original metadata retained"));
      const providers = node("div", undefined, "provider-links");
      for (const provider of detail.providers) {
        const target = new URL(provider.url);
        if (target.protocol !== "https:") continue;
        const anchor = node("a", `${names[provider.source]} (${provider.country}) ↗`, "text-action");
        anchor.href = target.href; anchor.target = "_blank"; anchor.rel = "noopener noreferrer";
        providers.append(anchor);
      }
      content.append(providers);
      if (detail.providers_truncated) content.append(node("p", "First 100 linked records shown."));
    }
    if (detail.annotations?.attribution) {
      content.append(node("p", detail.annotations.attribution, "attribution"));
      const attributionLinks = node("div", undefined, "provider-links");
      for (const [label, address] of [["License", detail.annotations.license_url], ["Original listing", detail.annotations.landing_url]]) {
        if (!address) continue;
        const target = new URL(address);
        if (!["https:", "http:"].includes(target.protocol)) continue;
        const anchor = node("a", `${label} ↗`, "text-action");
        anchor.href = target.href; anchor.target = "_blank"; anchor.rel = "noopener noreferrer";
        attributionLinks.append(anchor);
      }
      content.append(attributionLinks);
    }
    if (detail.links?.length) {
      const links = node("div", undefined, "provider-links");
      for (const external of detail.links) {
        const status = external.canonical_status === "conflict" ? " · identity conflict" : external.canonical_status === "excluded" ? " · not grouped" : "";
        const anchor = node("a", `${names[external.provider] || external.provider}${status} ↗`, "text-action");
        const target = new URL(external.url);
        if (target.protocol !== "https:") continue;
        anchor.href = target.href; anchor.target = "_blank"; anchor.rel = "noopener noreferrer";
        links.append(anchor);
      }
      content.append(links);
    }
    const link = node("a", "View source ↗", "text-action");
    const url = new URL(record.url);
    if (url.protocol === "https:") link.href = url.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    replace($("entity-detail"), [content, link]);
    if (network.mode === "atlas" || network.mode === "embeddings") {
      const explore = node("button", "Explore this record’s connections");
      explore.type = "button";
      explore.addEventListener("click", () => {
        network.mode = "catalog";
        $("graph-view").value = "catalog";
        loadNetwork({ key });
      });
      content.append(explore);
      $("graph-scope").textContent = `${record.title} · select Explore connections for its neighborhood`;
      if (network.mode === "atlas") renderConnections(state.graph);
    } else if (network.mode === "catalog" || (network.mode === "artists" && record.kind === "artist")) {
      await loadNetwork({ key, append: true });
    } else {
      const graph = await request(`/v1/console/graph/${encodeURIComponent(key)}`);
      if (state.selected !== key) return;
      network.mode = "recent";
      network.request?.abort();
      $("graph-view").value = "recent";
      $("artist-search").hidden = true;
      $("network-more").disabled = true;
      $("graph-scope").textContent = `${record.title} · ${graph.truncated ? "First 100" : "Explicit"} relationships`;
      $("network-notice").textContent = "Source-scoped record relationships. Switch to Artist connections for shared credits across provider identities.";
      drawGraph(graph);
    }
    $("map-heading").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "nearest" });
  } catch (error) {
    if (state.selected === key) {
      state.selected = previous;
      graphView?.select(previous);
      $("graph-record").value = previous || "";
      $("graph-scope").textContent = previousScope;
    }
    notice(`Could not inspect record: ${error.message}`);
  }
}

async function refresh() {
  const data = await request("/v1/console/snapshot");
  state.lastAt = data.at;
  render(data);
}

$("search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  state.searchAbort?.abort();
  const controller = new AbortController();
  state.searchAbort = controller;
  const params = new URLSearchParams();
  for (const [key, value] of new FormData(event.currentTarget)) if (value) params.set(key, value.trim());
  params.set("limit", "20");
  $("search-status").textContent = "Searching local metadata and vectors…";
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    const data = await request(`/v1/search?${params}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
    $("search-status").textContent = `${data.results.length} ${data.mode} results${data.has_more ? " · More candidates available; refine your query." : ""}`;
    replace($("results"), data.results.length ? data.results.map((record) => {
      const row = node("button", undefined, "result-row");
      row.type = "button";
      const title = node("div");
      title.append(node("strong", record.title), node("small", record.artist || record.kind));
      const sources = record.providers?.length ? [...new Set(record.providers.map((provider) => names[provider.source]))].join(" · ") : names[record.source];
      row.append(title, node("span", record.album || record.kind), node("span", sources), node("span", record.revision === record.indexed_revision ? "Indexed" : "Pending vectors"), node("span", "↗"));
      row.addEventListener("click", () => inspect(record.key));
      return row;
    }) : [empty("No records found. Add a seed or wait for discovery, then search again.")]);
  } catch (error) {
    if (controller.signal.aborted) return;
    $("search-status").textContent = `Search failed: ${error.message}`;
    replace($("results"), [empty("No new results loaded. For vector outages, choose Keyword only and try again.")]);
  } finally { if (state.searchAbort === controller) button.disabled = false; }
});

function seedHelp() {
  const source = $("seed-source").value;
  const kind = $("seed-kind").value;
  const metadata = state.snapshot?.sources.find((entry) => entry.id === source);
  const enabled = metadata?.enabled;
  $("country-field").hidden = source !== "apple";
  for (const option of $("seed-kind").options) option.disabled = metadata ? !metadata.kinds.includes(option.value) : false;
  if (metadata && !metadata.kinds.includes(kind)) $("seed-kind").value = metadata.kinds[0];
  const effective = $("seed-kind").value;
  const hint = ({musicbrainz: "MusicBrainz UUID", apple: "Apple numeric ID", spotify: "22-character Spotify ID", deezer: "Deezer numeric ID", audius: "Audius encoded ID", archive: "Live Music Archive item identifier", wikidata: "Q… Wikidata ID", soundcloud: effective === "song" ? "user~track URL slugs" : "user URL slug", openverse: "Openverse UUID", discogs: effective === "artist" ? "Discogs numeric artist ID" : "m<master ID> or r<release ID>"})[source] || (effective === "song" ? "11-character video ID" : effective === "artist" ? "UC… channel / artist browse ID" : "MPRE… album browse ID");
  $("seed-id").placeholder = hint;
  $("seed-help").textContent = enabled === false ? `${names[source]} is disabled. Enable it in .env and run docker compose up -d before adding seeds.` : `Use the explicit ${hint}, not a URL or name. Existing identities are deduplicated.`;
  $("seed-form").querySelector("button").disabled = enabled === false;
}
$("seed-source").addEventListener("change", seedHelp);
$("seed-kind").addEventListener("change", seedHelp);
$("seed-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form));
  payload.identifier = payload.identifier.trim();
  if (payload.source !== "apple") payload.country = "global";
  const button = form.querySelector("button");
  button.disabled = true;
  $("seed-status").textContent = "Queueing discovery…";
  try {
    const result = await control("/v1/console/seed", payload);
    $("seed-status").textContent = `${result.status}: ${displayKey(result.key)}`;
    await refresh();
  } catch (error) { $("seed-status").textContent = `Not queued: ${error.message}`; } finally { button.disabled = false; }
});

$("live-toggle").addEventListener("click", () => {
  state.paused = !state.paused;
  $("live-toggle").textContent = state.paused ? "Resume view" : "Pause view";
  if (state.paused) { clearTimeout(state.reconnect); state.socket?.close(); setConnection("View paused", false); }
  else connect();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { clearTimeout(state.reconnect); state.socket?.close(); }
  else if (!state.paused) connect();
});
$("reset-graph").addEventListener("click", () => {
  if (network.mode === "embeddings") embedding.view?.fit();
  else graphView?.fit();
});
$("embedding-more").addEventListener("click", () => loadEmbeddings({ append: true }));
$("embedding-all").addEventListener("click", () => {
  embedding.all = true;
  $("embedding-stop").hidden = false;
  loadEmbeddings({ append: true });
});
$("embedding-stop").addEventListener("click", () => {
  embedding.all = false;
  embedding.request?.abort();
  $("embedding-stop").hidden = true;
  renderEmbeddingPoints();
  $("graph-scope").textContent = "Loading stopped · loaded points retained";
});
$("embedding-query").addEventListener("input", embeddingPicker);
$("embedding-display").addEventListener("change", (event) => embedding.view?.setMode(event.target.value));
$("network-overview").addEventListener("click", () => {
  if (network.mode === "embeddings") {
    embedding.all = false;
    embedding.request?.abort();
  }
  state.selected = null;
  network.focus = null;
  network.next = null;
  network.query = "";
  $("artist-query").value = "";
  replace($("entity-detail"), [node("p", "Select any node to inspect its sources and expand stored connections.")]);
  if (network.mode !== "recent") loadNetwork();
  else if (state.snapshot) {
    $("graph-scope").textContent = "Recent records and direct relationships";
    drawGraph(state.snapshot.graph);
  }
});
$("graph-view").addEventListener("change", (event) => {
  network.mode = event.target.value;
  embedding.all = false;
  embedding.request?.abort();
  network.request?.abort();
  network.loading = false;
  state.selected = null;
  setNetworkSurface();
  $("atlas-breadcrumbs").hidden = network.mode !== "atlas";
  $("network-more").hidden = network.mode === "atlas";
  $("network-query-label").textContent = network.mode === "artists" ? "Find artists across the catalog" : "Find artists, genres, songs or albums";
  $("artist-query").placeholder = network.mode === "artists" ? "Artist name" : "Name or genre";
  $("network-more").disabled = true;
  if (network.mode !== "recent") loadNetwork();
  else {
    $("graph-scope").textContent = "Recent records and direct relationships";
    $("network-notice").textContent = "Recent 60 records plus fetched neighbors, not the whole catalog. Artist connections supports catalog-wide artist browsing.";
    $("graph-coverage").textContent = "Recent crawl sample";
    if (state.snapshot) drawGraph(state.snapshot.graph);
  }
});
$("artist-search").addEventListener("submit", (event) => {
  event.preventDefault();
  if (network.mode === "atlas") {
    network.mode = "catalog";
    $("graph-view").value = "catalog";
  }
  network.query = $("artist-query").value.trim();
  state.selected = null;
  loadNetwork();
});
$("network-more").addEventListener("click", () => {
  if (!network.loading && network.next) loadNetwork({ key: network.focus, after: network.next, append: Boolean(network.focus) });
});
$("graph-record").addEventListener("change", (event) => {
  if (event.target.value) inspect(event.target.value);
});
$("expand-graph").addEventListener("click", (event) => {
  const expanded = document.querySelector(".observatory").classList.toggle("map-expanded");
  event.currentTarget.setAttribute("aria-pressed", String(expanded));
  event.currentTarget.textContent = expanded ? "Collapse" : "Expand";
  requestAnimationFrame(() => {
    if (network.mode === "embeddings") embedding.view?.resizeView();
    else { graphView?.cy.resize(); graphView?.fit(); }
  });
});
$("zoom-in").addEventListener("click", () => (network.mode === "embeddings" ? embedding.view : graphView)?.zoom(1.25));
$("zoom-out").addEventListener("click", () => (network.mode === "embeddings" ? embedding.view : graphView)?.zoom(.8));
$("graph-layout").addEventListener("change", (event) => graphView?.arrange(event.target.value));
$("graph-spacing").addEventListener("input", (event) => {
  const spacing = Number(event.target.value);
  $("spacing-value").textContent = `${spacing.toFixed(1)}×`;
});
$("graph-spacing").addEventListener("change", (event) => {
  graphView?.setSpacing(Number(event.target.value));
});
$("focus-graph").addEventListener("click", () => graphView?.toggleFocus());
let graphView = null;
let relationshipFailure = "";
try {
  graphView = new CatalogGraphView($("network"), {
    inspect,
    zoomExpand: (key) => {
      if (network.mode === "atlas" && !network.loading) inspect(key);
    },
    connection: (edge) => {
      if (!["artists", "catalog", "atlas"].includes(state.graph?.scope)) {
        $("graph-scope").textContent = `Explicit ${edge.relation} relationship · select either record to inspect`;
        return;
      }
      $("inspector").open = true;
      renderConnections(state.graph, edge);
      $("network-evidence").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "nearest" });
    },
    selection: () => {
      network.request?.abort();
      network.loading = false;
      state.selected = null;
      $("graph-record").value = "";
      if (state.graph) renderConnections(state.graph);
    },
    tooltip: (record, edge) => {
      $("graph-tooltip").hidden = !record;
      if (!record) return;
      if (edge) {
        $("graph-tooltip").textContent = record.count !== undefined ? `${number(record.count)} stored ${record.relation} relationships · aggregate, not artist similarity` : `${record.relation === "shared_credit" ? "Shared credits" : record.relation === "genre" ? "Source genre tag" : `Explicit ${record.relation} relationship`} · click for source evidence`;
      } else {
        $("graph-tooltip").textContent = record.group ? `${record.title} · ${number(record.count)} ${record.kind === "genre" ? "tags" : "records"} · zoom or select to expand` : record.kind === "genre" ? `${record.title} · explicit source genre tag` : `${record.title} · ${(record.sources || [record.source]).map((source) => names[source] || source).join(" / ")} · ${record.kind}`;
      }
    },
    status: (data) => {
      if (network.mode === "embeddings") return;
      $("graph-count").textContent = `${data.nodes} ${data.focused ? `of ${data.total} loaded` : "visible"} ${network.mode === "artists" ? "artists" : "nodes"} · ${data.edges} links`;
      $("graph-topology").textContent = `${data.groups} connected neighborhoods · ${data.unlinked} unlinked`;
      $("focus-graph").disabled = !data.selected;
      $("focus-graph").setAttribute("aria-pressed", String(data.focused));
      $("focus-graph").textContent = data.focused ? "Show all loaded" : "Focus neighbors";
    },
  });
} catch (error) {
  relationshipFailure = `Graph renderer unavailable: ${error.message}. Refresh to retry. The record picker and connection evidence below remain available.`;
  $("graph-failure").hidden = false;
  $("graph-failure").textContent = relationshipFailure;
}
setInterval(() => {
  if (!state.lastAt) return;
  const seconds = Math.max(0, Math.round(Date.now() / 1000 - state.lastAt));
  $("snapshot-age").textContent = `Snapshot ${seconds}s ago${state.paused ? " · view paused" : ""}`;
  if (storageAt) $("storage-age").textContent = `Storage measured ${Math.max(0, Math.round(Date.now() / 1000 - storageAt))}s ago`;
  if (!state.paused && !document.hidden && seconds > 20) setConnection("Telemetry stale", false);
}, 1000);
setInterval(() => {
  if (!state.paused && !document.hidden) loadStorage();
  if (!["recent", "embeddings"].includes(network.mode) && network.overview && !network.loading && !state.selected && !state.paused && !document.hidden) loadNetwork();
}, 30000);
connect();
loadNetwork();
loadStorage();
