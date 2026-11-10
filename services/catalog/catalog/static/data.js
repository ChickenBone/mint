"use strict";

const $ = (id) => document.getElementById(id);
const state = { tables: [], rows: [], rawRows: [], next: null, history: [null], page: 0, controller: null, raw: null, request: 0, inspection: 0, view: null };
const element = (tag, text) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; return item; };

async function request(path, signal) {
  const response = await fetch(path, { signal: signal ?? AbortSignal.timeout(15000) });
  let data;
  try { data = await response.json(); } catch { throw new Error(`Unexpected server response (${response.status}). Retry the page.`); }
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : `Request failed (${response.status}). Check the filter and retry.`);
  return data;
}

function error(message) { $("browser-error").textContent = message; $("browser-error").hidden = !message; }
function clearInspector() {
  state.inspection++;
  state.raw = null;
  $("copy-json").disabled = true;
  $("copy-status").textContent = "";
  $("raw-record").textContent = "No record selected.";
  $("raw-note").textContent = "Inspect a row to see every field. Qdrant vectors load on selection.";
}
function controls(loading) {
  $("browse").disabled = loading;
  $("refresh-data").disabled = loading;
  $("previous").disabled = loading || state.page === 0;
  $("next").disabled = loading || !state.next;
  $("records").setAttribute("aria-busy", String(loading));
}
function view() {
  return { database: $("database").value, table: $("dataset").value, exact: $("exact").value.trim(), limit: $("page-size").value };
}
function schema() {
  const pg = $("database").value === "postgres";
  $("table-field").hidden = !pg;
  const table = state.tables.find((item) => item.name === $("dataset").value);
  $("exact-label").textContent = pg ? `Exact ${table?.primary_key[0] ?? "primary key"}` : "Exact entity key (payload.key)";
  const fields = pg ? (table?.columns ?? []).map((column) => `${column.name}: ${column.type}${column.nullable ? " | null" : ""}`) : ["id: UUID", "payload: JSON", "vector: 384 floating-point values (on inspection)"];
  $("schema-detail").replaceChildren(...fields.map((field) => element("span", field)));
}

async function load(reset = false) {
  const currentView = view();
  if (reset || JSON.stringify(currentView) !== JSON.stringify(state.view)) {
    state.history = [null]; state.page = 0;
  }
  state.view = currentView;
  const number = ++state.request;
  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;
  state.next = null;
  state.rows = [];
  clearInspector();
  $("record-head").replaceChildren(); $("record-body").replaceChildren();
  $("empty-data").hidden = true;
  error("");
  controls(true);
  schema();
  const pg = currentView.database === "postgres";
  $("dataset-heading").textContent = pg ? `public.${currentView.table}` : "Qdrant collection";
  $("dataset-note").textContent = pg ? "All stored columns · primary-key order · read-only" : "Stored point payloads · point-ID order · vectors fetched individually";
  $("browse-status").textContent = "Loading stored records…";
  $("page-label").textContent = `Page ${state.page + 1}`;
  const params = new URLSearchParams({ limit: currentView.limit });
  if (currentView.exact) params.set("exact", currentView.exact);
  if (state.history[state.page]) params.set("after", state.history[state.page]);
  const path = pg ? `/v1/data/postgres/${encodeURIComponent(currentView.table)}` : "/v1/data/vectors";
  try {
    const data = await request(`${path}?${params}`, AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]));
    if (number !== state.request) return;
    state.rows = data.rows; state.rawRows = data.raw_rows ?? []; state.next = data.next;
    if (!pg) {
      $("dataset-heading").textContent = data.collection;
      $("dataset-note").textContent = `${data.dimensions} dimensions · ${data.reported_points ?? "Unknown"} reported points · ${data.status} · not a filtered total`;
    }
    render(pg);
    $("browse-status").textContent = `${data.rows.length} ${data.rows.length === 1 ? "record" : "records"} on page ${state.page + 1}${data.next ? " · More records available" : " · End of this view"}. Select Inspect for raw JSON.`;
    $("empty-data").hidden = data.rows.length > 0;
  } catch (failure) {
    if (controller.signal.aborted || number !== state.request) return;
    error(`Could not load data: ${failure.message}`);
    $("browse-status").textContent = "No records loaded. Correct the filter or use Refresh page to retry.";
  } finally { if (number === state.request) controls(false); }
}

function render(pg) {
  let columns = pg ? state.tables.find((table) => table.name === state.view.table)?.columns.map((column) => column.name) ?? [] : ["id", "key", "source", "kind", "revision"];
  if (pg && state.view.table === "entities") {
    const leading = ["title", "artist", "kind", "source", "key"];
    columns = [...leading, ...columns.filter((column) => !leading.includes(column))];
  }
  const header = element("tr");
  header.append(element("th", "Inspect"), ...columns.map((column) => element("th", column)));
  for (const cell of header.children) cell.scope = "col";
  $("record-head").replaceChildren(header);
  $("record-body").replaceChildren(...state.rows.map((row, index) => {
    const tr = element("tr");
    const action = element("td"), button = element("button", "Inspect");
    button.type = "button";
    button.setAttribute("aria-label", `Inspect record ${index + 1}`);
    button.addEventListener("click", () => inspect(index, pg));
    action.append(button); tr.append(action);
    for (const column of columns) {
      const value = pg ? row[column] : column === "id" ? row.id : row.payload?.[column];
      const text = value === null || value === undefined ? "null" : typeof value === "object" ? JSON.stringify(value) : String(value);
      const cell = element("td", text.length > 160 ? `${text.slice(0, 157)}…` : text);
      if (value === null || value === undefined) cell.className = "null-value";
      tr.append(cell);
    }
    return tr;
  }));
}

async function inspect(index, pg) {
  clearInspector();
  const inspection = state.inspection;
  [...$("record-body").children].forEach((row, i) => row.classList.toggle("selected", i === index));
  $("raw-record").textContent = "Loading raw record…";
  try {
    const record = state.rows[index];
    const data = pg ? record : await request(`/v1/data/vectors/${encodeURIComponent(record.id)}`);
    if (inspection !== state.inspection) return;
    state.raw = pg ? state.rawRows[index] : data.raw_json;
    $("raw-record").textContent = state.raw;
    $("raw-note").textContent = pg ? "Complete stored row, including nulls and PostgreSQL-generated fields." : `${data.vector?.length ?? 0} stored vector dimensions · complete payload · not the quantized search representation.`;
    $("copy-json").disabled = false;
  } catch (failure) {
    if (inspection !== state.inspection) return;
    $("raw-record").textContent = `Could not inspect record: ${failure.message}`;
    $("raw-note").textContent = "Select the row again to retry.";
  }
}

function reload(reset = false) {
  if ($("database").value === "postgres" && !state.tables.length) return initialize();
  return load(reset);
}
$("browse-form").addEventListener("submit", (event) => { event.preventDefault(); reload(true); });
$("database").addEventListener("change", () => { $("exact").value = ""; reload(true); });
$("dataset").addEventListener("change", () => { $("exact").value = ""; load(true); });
$("page-size").addEventListener("change", () => load(true));
$("refresh-data").addEventListener("click", () => reload());
$("next").addEventListener("click", () => { state.history[++state.page] = state.next; load(); });
$("previous").addEventListener("click", () => { state.page--; load(); });
$("copy-json").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(state.raw); $("copy-status").textContent = "JSON copied."; }
  catch { $("copy-status").textContent = "Clipboard unavailable. Select and copy the raw JSON directly."; }
});

async function initialize() {
  const number = ++state.request;
  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;
  state.next = null;
  state.rows = [];
  clearInspector();
  error("");
  schema();
  $("record-head").replaceChildren(); $("record-body").replaceChildren();
  $("empty-data").hidden = true;
  $("dataset-heading").textContent = "PostgreSQL";
  $("dataset-note").textContent = "Loading the standalone catalog schema…";
  $("browse-status").textContent = "Loading PostgreSQL schema…";
  controls(true);
  try {
    const data = await request("/v1/data/tables", AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
    if (number !== state.request) return;
    state.tables = data.tables;
    $("dataset").replaceChildren(...data.tables.map((table) => { const option = element("option", table.name); option.value = table.name; return option; }));
    $("dataset").disabled = false;
    await load(true);
  } catch (failure) {
    if (controller.signal.aborted || number !== state.request) return;
    error(`Could not load PostgreSQL schema: ${failure.message} Qdrant can still be selected above.`);
    $("browse-status").textContent = "Use Load data to retry, or select Qdrant.";
    $("dataset").replaceChildren(element("option", "entities"));
    controls(false);
  }
}
initialize();
