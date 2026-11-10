import { EmbeddingView } from "./embedding-atlas.js";

const COLORS = ["#7ff0c3", "#8cbefb", "#c1a8da"];
const CATEGORIES = { artist: 0, album: 1, song: 2 };

export class CatalogEmbeddingMap {
  constructor(container, callbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.records = [];
    this.byKey = new Map();
    this.cells = new Map();
    this.viewport = null;
    this.mode = "points";
    this.view = null;
    this.resize = new ResizeObserver(() => this.resizeView());
    this.resize.observe(container);
    container.addEventListener("keydown", (event) => {
      if (event.target !== container || !this.viewport) return;
      const step = .15 / this.viewport.scale;
      const next = { ...this.viewport };
      if (event.key === "ArrowLeft") next.x -= step;
      else if (event.key === "ArrowRight") next.x += step;
      else if (event.key === "ArrowUp") next.y -= step;
      else if (event.key === "ArrowDown") next.y += step;
      else if (event.key === "+" || event.key === "=") this.zoom(1.25);
      else if (event.key === "-") this.zoom(.8);
      else if (event.key === "0") this.fit();
      else if (event.key === "Escape") this.view?.update({ selection: null });
      else return;
      event.preventDefault();
      if (event.key.startsWith("Arrow")) this.view?.update({ viewportState: next });
    });
  }

  update(records, { append = false } = {}) {
    if (!append) this.byKey.clear();
    for (const record of records) this.byKey.set(record.key, record);
    this.records = [...this.byKey.values()];
    const data = {
      x: Float32Array.from(this.records, (row) => row.x),
      y: Float32Array.from(this.records, (row) => row.y),
      category: Uint8Array.from(this.records, (row) => CATEGORIES[row.kind]),
    };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const row of this.records) {
      minX = Math.min(minX, row.x); maxX = Math.max(maxX, row.x);
      minY = Math.min(minY, row.y); maxY = Math.max(maxY, row.y);
    }
    this.bounds = this.records.length ? { minX, maxX, minY, maxY } : { minX: 0, maxX: 1, minY: 0, maxY: 1 };
    this.cells.clear();
    this.cellX = Math.max(.001, this.bounds.maxX - this.bounds.minX) / 128;
    this.cellY = Math.max(.001, this.bounds.maxY - this.bounds.minY) / 128;
    for (const row of this.records) {
      const cell = `${Math.floor((row.x - this.bounds.minX) / this.cellX)},${Math.floor((row.y - this.bounds.minY) / this.cellY)}`;
      if (!this.cells.has(cell)) this.cells.set(cell, []);
      this.cells.get(cell).push(row);
    }
    const props = {
      data,
      width: Math.max(1, this.container.clientWidth),
      height: Math.max(1, this.container.clientHeight),
      pixelRatio: Math.min(devicePixelRatio || 1, 2),
      categoryColors: COLORS,
      config: { colorScheme: "dark", mode: this.mode, autoLabelEnabled: false },
      theme: { fontFamily: "system-ui, sans-serif", statusBar: false },
      querySelection: async (x, y, unit) => this.nearest(x, y, unit),
      onViewportState: (viewport) => { this.viewport = viewport; },
      onTooltip: (point) => this.callbacks.tooltip(point ? this.byKey.get(point.identifier) : null),
      onSelection: (points) => {
        const key = points?.at(-1)?.identifier;
        if (key && key !== this.selected) {
          this.selected = key;
          this.callbacks.inspect(key);
        } else if (!key) this.selected = null;
      },
    };
    if (this.view) this.view.update(props);
    else this.view = new EmbeddingView(this.container, props);
    if (!append) this.fit();
  }

  nearest(x, y, unit) {
    const radius = Math.max(0, unit) * 12;
    let best = null, distance = radius * radius;
    const startX = Math.max(0, Math.floor((x - radius - this.bounds.minX) / this.cellX));
    const endX = Math.min(128, Math.floor((x + radius - this.bounds.minX) / this.cellX));
    const startY = Math.max(0, Math.floor((y - radius - this.bounds.minY) / this.cellY));
    const endY = Math.min(128, Math.floor((y + radius - this.bounds.minY) / this.cellY));
    for (let cx = startX; cx <= endX; cx++) {
      for (let cy = startY; cy <= endY; cy++) {
        for (const row of this.cells.get(`${cx},${cy}`) || []) {
          const squared = (row.x - x) ** 2 + (row.y - y) ** 2;
          if (squared <= distance) { best = row; distance = squared; }
        }
      }
    }
    return best ? this.point(best) : null;
  }

  point(row) {
    return { x: row.x, y: row.y, category: CATEGORIES[row.kind], identifier: row.key,
      text: `${row.title}${row.artist ? ` · ${row.artist}` : ""} · ${row.source} / ${row.kind}` };
  }

  select(key) {
    const row = this.byKey.get(key);
    if (row) {
      this.selected = key;
      this.view?.update({ selection: [this.point(row)] });
    }
  }

  setMode(mode) {
    this.mode = mode;
    this.view?.update({ config: { colorScheme: "dark", mode, autoLabelEnabled: false } });
  }

  resizeView() {
    if (this.container.clientWidth) this.view?.update({
      width: this.container.clientWidth, height: this.container.clientHeight,
    });
  }

  fit() {
    if (!this.records.length) return;
    const { minX, maxX, minY, maxY } = this.bounds;
    this.viewport = { x: (minX + maxX) / 2, y: (minY + maxY) / 2,
      scale: 1.65 / Math.max(maxX - minX, maxY - minY, .01) };
    this.view?.update({ viewportState: this.viewport });
  }

  zoom(factor) {
    if (this.viewport) this.view?.update({ viewportState: { ...this.viewport, scale: Math.max(.01, Math.min(100000, this.viewport.scale * factor)) } });
  }
}
