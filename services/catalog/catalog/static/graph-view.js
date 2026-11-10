"use strict";

globalThis.CatalogGraphView = class {
  constructor(container, { inspect, connection, selection, tooltip, status, zoomExpand }) {
    this.container = container;
    this.callbacks = { inspect, connection, selection, tooltip, status, zoomExpand };
    this.layoutName = "cose";
    this.focused = false;
    this.selectedKey = null;
    this.signature = "";
    this.spacing = 1.8;
    this.zoomBaseline = 1;
    this.zoomTimer = null;
    this.atlas = false;
    this.reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    this.cy = cytoscape({
      container,
      elements: [],
      minZoom: .03, maxZoom: 3,
      boxSelectionEnabled: false, selectionType: "single",
      autounselectify: true,
      style: [
        { selector: "node", style: {
          width: "data(size)", height: "data(size)", label: "data(label)",
          "background-color": "#22584f", "border-color": "#7ff0c3", "border-width": 2,
          color: "#e8f0f8", "font-family": "Segoe UI, Arial, sans-serif", "font-size": 13,
          "text-valign": "bottom", "text-margin-y": 9, "text-wrap": "ellipsis",
          "text-max-width": 150, "text-outline-color": "#0c1622", "text-outline-width": 3,
          "text-opacity": 0, "min-zoomed-font-size": 0, "overlay-opacity": 0,
        } },
        { selector: 'node[kind = "album"]', style: {
          shape: "round-rectangle", "background-color": "#294b70", "border-color": "#8cbefb",
        } },
        { selector: 'node[kind = "song"]', style: {
          "background-color": "#5b486c", "border-color": "#d7b8f1",
        } },
        { selector: 'node[kind = "genre"]', style: {
          shape: "hexagon", "background-color": "#66502d", "border-color": "#ffce81",
          "font-weight": 600,
        } },
        { selector: "node[grouped = 1]", style: {
          "border-width": 3, "text-wrap": "wrap", "font-weight": 600,
        } },
        { selector: "edge", style: {
          width: "mapData(weight, 1, 5, 1.5, 4)", "line-color": "#627e97",
          "curve-style": "bezier", opacity: .65, "overlay-opacity": 0,
          "line-cap": "round",
        } },
        { selector: 'edge[relation = "genre"]', style: {
          "line-color": "#b69b6b", "line-style": "dashed", opacity: .7,
        } },
        { selector: 'edge[relation = "artist"], edge[relation = "album"]', style: {
          "target-arrow-shape": "triangle", "target-arrow-color": "#627e97", "arrow-scale": .7,
        } },
        { selector: ".muted", style: { opacity: .15 } },
        { selector: "node.labelled", style: { "text-opacity": 1 } },
        { selector: "edge.emphasis", style: { opacity: 1, "line-color": "#7ff0c3", "target-arrow-color": "#7ff0c3", "z-index": 5 } },
        { selector: "node.emphasis", style: { opacity: 1, "border-width": 3, "z-index": 10, "min-zoomed-font-size": 0 } },
        { selector: "node.active", style: {
          "border-color": "#ffffff", "border-width": 4, "background-color": "#357365",
          "font-weight": 600, "z-index": 20, "text-opacity": 1,
        } },
        { selector: ".outside", style: { display: "none" } },
      ],
    });
    this.cy.on("tap", "node", (event) => this.callbacks.inspect(event.target.data("key")));
    this.cy.on("tap", "edge", (event) => {
      this.cy.elements().removeClass("active emphasis muted");
      event.target.addClass("emphasis");
      event.target.connectedNodes().addClass("emphasis");
      this.cy.elements().difference(event.target.closedNeighborhood()).addClass("muted");
      this.callbacks.connection(event.target.data("record"));
    });
    this.cy.on("tap", (event) => {
      if (event.target !== this.cy) return;
      this.select(null);
      this.callbacks.selection(null);
    });
    this.cy.on("mouseover", "node, edge", (event) => {
      container.style.cursor = "pointer";
      const element = event.target;
      if (element.isNode()) this.highlight(element);
      this.callbacks.tooltip(element.data("record"), element.isEdge());
    });
    this.cy.on("mouseout", "node, edge", () => {
      container.style.cursor = "grab";
      this.highlight(this.selectedNode());
      this.callbacks.tooltip(null);
    });
    this.cy.on("drag", "node", () => this.callbacks.tooltip(null));
    this.cy.on("zoom", () => {
      this.readability();
      clearTimeout(this.zoomTimer);
      if (!this.atlas || !this.callbacks.zoomExpand) return;
      this.zoomTimer = setTimeout(() => {
        if (this.cy.destroyed() || this.cy.zoom() < this.zoomBaseline * 1.8) return;
        const center = { x: this.cy.width() / 2, y: this.cy.height() / 2 };
        const groups = this.cy.nodes().not(".outside").filter((element) => {
          const point = element.renderedPosition();
          return element.data("grouped") && element.renderedWidth() >= 28 && Math.hypot(point.x - center.x, point.y - center.y) < Math.min(this.cy.width(), this.cy.height()) / 3;
        }).toArray().sort((a,b) => Math.hypot(a.renderedPosition().x - center.x, a.renderedPosition().y - center.y) - Math.hypot(b.renderedPosition().x - center.x, b.renderedPosition().y - center.y));
        if (groups.length) this.callbacks.zoomExpand(groups[0].data("key"));
      }, 400);
    });
    container.addEventListener("keydown", (event) => {
      if (event.target !== container || event.altKey || event.ctrlKey || event.metaKey) return;
      const moves = { ArrowLeft: { x: 65, y: 0 }, ArrowRight: { x: -65, y: 0 }, ArrowUp: { x: 0, y: 65 }, ArrowDown: { x: 0, y: -65 } };
      if (moves[event.key]) this.cy.panBy(moves[event.key]);
      else if (event.key === "+" || event.key === "=") this.zoom(1.25);
      else if (event.key === "-") this.zoom(.8);
      else if (event.key === "0") this.fit();
      else if (event.key === "Escape") { this.select(null); this.callbacks.selection(null); }
      else return;
      event.preventDefault();
    });
    this.resizeObserver = new ResizeObserver(() => { this.cy.resize(); this.readability(); });
    this.resizeObserver.observe(container);
  }

  selectedNode() {
    return this.selectedKey ? this.cy.getElementById(`node:${this.selectedKey}`) : this.cy.collection();
  }

  update(graph, selectedKey) {
    clearTimeout(this.zoomTimer);
    this.atlas = graph.scope === "atlas";
    const elements = CatalogGraph.elements(graph);
    const signature = JSON.stringify([graph.scope, elements.map((element) => element.data.id).sort()]);
    const changed = signature !== this.signature;
    this.signature = signature;
    const ids = new Set(elements.map((element) => element.data.id));
    this.cy.batch(() => {
      this.cy.elements().filter((element) => !ids.has(element.id())).remove();
      for (const element of elements) {
        const existing = this.cy.getElementById(element.data.id);
        if (existing.length) existing.data(element.data);
        else this.cy.add(element);
      }
    });
    const wasFocused = this.focused;
    this.select(selectedKey, false);
    if (changed || wasFocused !== this.focused) this.arrange();
    this.readability();
    this.report();
  }

  select(key, arrange = true) {
    const wasFocused = this.focused;
    this.selectedKey = key;
    const selected = this.selectedNode();
    this.cy.elements().removeClass("active outside");
    if (selected.length) selected.addClass("active");
    else this.focused = false;
    if (this.focused) this.cy.elements().difference(selected.closedNeighborhood()).addClass("outside");
    this.highlight(selected);
    this.readability();
    if (arrange && (wasFocused || this.focused)) this.arrange();
    this.report();
  }

  highlight(element) {
    this.cy.batch(() => {
      this.cy.elements().removeClass("muted emphasis");
      if (!element?.length) return;
      const neighborhood = element.closedNeighborhood();
      neighborhood.addClass("emphasis");
      this.cy.elements().difference(neighborhood).addClass("muted");
    });
  }

  toggleFocus() {
    this.focused = !this.focused;
    this.select(this.selectedKey, false);
    this.arrange();
  }

  arrange(name = this.layoutName) {
    this.layoutName = name;
    const elements = this.cy.elements().not(".outside");
    if (!elements.nodes().length) return;
    const options = this.atlas && !elements.edges().length
      ? { name: "grid", cols: Math.max(1, Math.ceil(Math.sqrt(elements.nodes().length * this.cy.width() / Math.max(1,this.cy.height())))), condense: true, spacingFactor: this.spacing }
      : name === "concentric"
      ? { name, minNodeSpacing: 85 * this.spacing, concentric: (node) => node.id() === `node:${this.selectedKey}` ? 10000 : node.degree(), levelWidth: () => 2 }
      : { name: "cose", randomize: true, numIter: 650, nodeRepulsion: () => 24000 * this.spacing ** 2, idealEdgeLength: () => 130 * this.spacing, componentSpacing: 160 * this.spacing, nodeOverlap: 40 };
    this.cy.nodes().removeStyle("width height font-size text-margin-y text-max-width text-outline-width border-width");
    elements.layout({ ...options, animate: false, fit: false, padding: 55, nodeDimensionsIncludeLabels: true }).run();
    this.fit();
    this.readability();
  }

  readability() {
    const zoom = this.cy.zoom();
    const visible = this.cy.nodes().not(".outside").toArray().sort((a, b) => b.degree() - a.degree() || a.id().localeCompare(b.id()));
    const labelCount = Math.max(4, Math.min(this.atlas ? 36 : 18, Math.floor(this.cy.width() * this.cy.height() / 20000)));
    const labels = [];
    this.cy.batch(() => {
      this.cy.nodes().removeClass("labelled").style({
        "font-size": 12 / zoom, "text-max-width": 120 / zoom,
        "text-margin-y": 8 / zoom, "text-outline-width": 2 / zoom,
      });
      for (const element of this.cy.nodes()) {
        const size = Math.max(element.data("size"), (element.data("grouped") ? 28 : 16) / zoom);
        element.style({ width: size, height: size });
      }
      for (const element of visible) {
        if (labels.length >= labelCount) break;
        const point = element.renderedPosition();
        const box = { x: point.x - 60, y: point.y + element.renderedHeight() / 2 + 8, width: 120, height: element.data("grouped") ? 36 : 20 };
        if (labels.some((other) => box.x < other.x + other.width && box.x + box.width > other.x && box.y < other.y + other.height && box.y + box.height > other.y)) continue;
        labels.push(box);
        element.addClass("labelled");
      }
    });
  }

  fit() {
    const elements = this.cy.elements().not(".outside");
    if (!elements.length) return;
    const viewport = this.cy.getFitViewport(elements, 55);
    if (!viewport) return;
    viewport.zoom = Math.min(1.4, Math.max(this.cy.minZoom(), viewport.zoom));
    this.zoomBaseline = viewport.zoom;
    // Keep an isolated node readable instead of magnifying it to fill the canvas.
    const center = elements.boundingBox();
    viewport.pan = {
      x: this.cy.width() / 2 - (center.x1 + center.x2) / 2 * viewport.zoom,
      y: this.cy.height() / 2 - (center.y1 + center.y2) / 2 * viewport.zoom,
    };
    this.cy.stop();
    if (this.reducedMotion.matches) this.cy.viewport(viewport);
    else this.cy.animate(viewport, { duration: 220, easing: "ease-out-cubic" });
  }

  zoom(factor) {
    this.cy.stop();
    this.cy.zoom({ level: Math.min(this.cy.maxZoom(), Math.max(this.cy.minZoom(), this.cy.zoom() * factor)), renderedPosition: { x: this.cy.width() / 2, y: this.cy.height() / 2 } });
  }

  setSpacing(value) {
    const factor = value / this.spacing;
    this.spacing = value;
    this.arrange();
    this.zoom(factor);
    clearTimeout(this.zoomTimer);
  }

  report() {
    const elements = this.cy.elements().not(".outside");
    const nodes = elements.nodes();
    const edges = elements.edges();
    this.callbacks.status({
      nodes: nodes.length, total: this.cy.nodes().length, edges: edges.length,
      groups: elements.components().filter((component) => component.nodes().length > 1).length,
      unlinked: nodes.filter((node) => node.connectedEdges().not(".outside").length === 0).length,
      focused: this.focused, selected: this.selectedNode().length > 0,
    });
  }
};
