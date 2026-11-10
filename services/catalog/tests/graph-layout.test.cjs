const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
require("../catalog/static/graph-layout.js");
const context = globalThis;
const cytoscape = require("../catalog/static/cytoscape.min.js");
const { createHash } = require("node:crypto");

test("Discogs seed controls require numeric artists and distinct master/release IDs", () => {
  const source = readFileSync(join(__dirname, "../catalog/static/console.js"), "utf8");
  const start = source.indexOf("function seedHelp()");
  const end = source.indexOf('$("seed-source").addEventListener', start);
  assert.ok(start >= 0 && end > start);
  const button = {};
  const fields = {
    "seed-source": { value: "discogs" },
    "seed-kind": { value: "artist", options: ["artist", "album", "song"].map(value => ({ value })) },
    "country-field": {}, "seed-id": {}, "seed-help": {},
    "seed-form": { querySelector: () => button },
  };
  const sandbox = {
    $: id => fields[id],
    state: { snapshot: { sources: [{ id: "discogs", enabled: true, kinds: ["artist", "album"] }] } },
  };
  require("node:vm").runInNewContext(source.slice(start, end) + "\nseedHelp();", sandbox);
  assert.equal(fields["seed-id"].placeholder, "Discogs numeric artist ID");
  assert.equal(fields["seed-kind"].options[2].disabled, true);
  assert.equal(fields["country-field"].hidden, true);
  fields["seed-kind"].value = "album";
  sandbox.seedHelp();
  assert.equal(fields["seed-id"].placeholder, "m<master ID> or r<release ID>");
  assert.equal(button.disabled, false);
});

test("Cytoscape adapter preserves actual relationships and ignores unfetched endpoints", () => {
  const nodes = Array.from({ length: 140 }, (_, i) => ({ key: `node-${i}`, kind: "song" }));
  const edges = nodes.slice(1).map((row, i) => ({ source: row.key, target: nodes[Math.floor(i/4)].key, relation: "artist" }));
  edges.push({ source: "node-0", target: "missing" });
  const elements = JSON.parse(JSON.stringify(context.CatalogGraph.elements({nodes, edges})));
  const cy = cytoscape({ headless: true, elements });
  try {
    assert.equal(cy.nodes().length, 140);
    assert.equal(cy.edges().length, 139);
    assert.equal(cy.elements().components().length, 1);
    for (const name of ["cose", "concentric"]) {
      cy.layout({ name, animate: false, numIter: 100 }).run();
      assert.ok(cy.nodes().every((node) => Number.isFinite(node.position().x) && Number.isFinite(node.position().y)));
    }
  } finally {
    cy.destroy();
  }
});

test("disconnected components and empty graphs are real, not fabricated relationships", () => {
  assert.equal(context.CatalogGraph.elements({nodes:[],edges:[]}).length, 0);
  const elements = context.CatalogGraph.elements({nodes:[{key:"a"}, {key:"b"}, {key:"c"}],edges:[{source:"a",target:"b"}]});
  const cy = cytoscape({headless:true,elements:JSON.parse(JSON.stringify(elements))});
  try {
    assert.equal(cy.elements().components().length, 2);
    assert.equal(cy.nodes().filter((node) => node.degree() === 0).length, 1);
    assert.equal(cy.edges().length, 1);
  } finally { cy.destroy(); }
});

test("adapter namespaces node/edge IDs and retains evidence with hostile-looking provider keys", () => {
  const nodes = [{key:'a:"]',title:'<img onerror=alert(1)>',kind:"artist"}, {key:'edge:["a"]',title:"Other"}];
  const edge = {source:nodes[0].key,target:nodes[1].key,relation:"shared_credit",evidence:[{key:"record-1",title:"Real credit"}],evidence_count:2};
  const elements = context.CatalogGraph.elements({nodes,edges:[edge,{...edge,source:edge.target,target:edge.source},{...edge,target:edge.source}]});
  assert.equal(elements.length,3);
  assert.equal(new Set(elements.map((element)=>element.data.id)).size,3);
  assert.equal(elements[0].data.label, nodes[0].title);
  assert.equal(elements[2].data.record.evidence[0].key, "record-1");
  assert.equal(elements[2].data.weight,2);
});

test("locally served Cytoscape matches the pinned npm distribution and retained MIT license", () => {
  const manifest = JSON.parse(readFileSync(join(__dirname,"../package.json")));
  const lock = JSON.parse(readFileSync(join(__dirname,"../package-lock.json")));
  assert.equal(cytoscape.version,manifest.dependencies.cytoscape);
  assert.equal(lock.packages["node_modules/cytoscape"].version,cytoscape.version);
  const vendor = readFileSync(join(__dirname,"../catalog/static/cytoscape.min.js"));
  assert.equal(createHash("sha256").update(vendor).digest("hex"),"081591ab735b2b6a3b31a3c60f8f3a3e2fee8c92939e0c7820ad1208571b6cd8");
  assert.match(readFileSync(join(__dirname,"../catalog/static/cytoscape.LICENSE.txt"),"utf8"),/Permission is hereby granted/);
});

test("Cytoscape view preserves manual positions/zoom on refresh and supports focus, evidence and keyboard", () => {
  const callbacks = { inspect:()=>{}, connection:()=>{}, selection:()=>{}, tooltip:()=>{}, status:()=>{} };
  let latest, inspected, connection, cleared = 0;
  callbacks.status = (value) => { latest = value; };
  callbacks.inspect = (key) => { inspected = key; };
  callbacks.connection = (edge) => { connection = edge; };
  callbacks.selection = () => { cleared++; };
  const handlers = {};
  const container = { style:{}, addEventListener:(name,fn)=>{handlers[name]=fn;} };
  context.matchMedia = () => ({matches:true});
  context.ResizeObserver = class { observe() {} };
  context.cytoscape = (options) => cytoscape({
    ...JSON.parse(JSON.stringify(options)), container:undefined, headless:true, styleEnabled:true,
  });
  require("../catalog/static/graph-view.js");
  const view = new context.CatalogGraphView(container,callbacks);
  const graph = {scope:"artists",nodes:[{key:"a",title:"Alpha"},{key:"b",title:"Beta"},{key:"c",title:"Solo"}],edges:[{source:"a",target:"b",relation:"shared_credit",evidence_count:1}]};
  try {
    view.update(graph,null);
    assert.equal(latest.nodes,3);
    assert.equal(latest.groups,1);
    assert.equal(latest.unlinked,1);
    view.cy.getElementById("node:a").position({x:333,y:444});
    view.cy.zoom(.75);
    view.cy.pan({x:40,y:50});
    view.update(graph,null);
    assert.deepEqual(view.cy.getElementById("node:a").position(),{x:333,y:444});
    assert.equal(view.cy.zoom(),.75);
    assert.deepEqual(view.cy.pan(),{x:40,y:50});
    view.cy.getElementById("node:b").position({x:333,y:444});
    view.readability();
    assert.ok(!(view.cy.getElementById("node:a").hasClass("labelled") && view.cy.getElementById("node:b").hasClass("labelled")));
    view.select("a");
    assert.ok(view.cy.getElementById("node:c").hasClass("muted"));
    view.toggleFocus();
    assert.equal(latest.focused,true);
    assert.equal(latest.nodes,2);
    assert.equal(latest.total,3);
    view.select(null);
    assert.equal(latest.focused,false);
    assert.equal(latest.nodes,3);
    view.cy.getElementById("node:a").emit("tap");
    assert.equal(inspected,"a");
    view.cy.edges().first().emit("tap");
    assert.equal(connection.relation,"shared_credit");
    view.arrange("concentric");
    assert.ok(view.cy.nodes().every((node)=>Number.isFinite(node.position().x)));
    const pan = {...view.cy.pan()};
    handlers.keydown({target:container,key:"ArrowRight",preventDefault(){}});
    assert.equal(view.cy.pan().x,pan.x-65);
    handlers.keydown({target:container,key:"Escape",preventDefault(){}});
    assert.equal(cleared,1);
    view.update({nodes:[],edges:[]},null);
    assert.equal(latest.nodes,0);
    assert.equal(latest.edges,0);
  } finally { view.cy.destroy(); }
});

test("progressive artist expansion merges canonical aliases and preserves evidence", () => {
  const merge = context.CatalogGraph.merge;
  const first = { nodes: [{key:"a",canonical_id:"artist-a"},{key:"b",canonical_id:"artist-b"}], edges: [{source:"a",target:"b",relation:"shared_credit",evidence:[{key:"song-1"}],evidence_count:1}] };
  const second = { nodes: [{key:"alias-a",canonical_id:"artist-a"},{key:"b",canonical_id:"artist-b"},{key:"c",canonical_id:"artist-c"}], edges: [{source:"b",target:"alias-a",relation:"shared_credit",evidence:[{key:"song-2"}],evidence_count:1},{source:"b",target:"c",relation:"shared_credit",evidence:[{key:"song-3"}],evidence_count:1}] };
  const result = merge(first, second);
  assert.equal(result.nodes.length, 3);
  assert.equal(result.edges.length, 2);
  const edge = result.edges.find((edge) => edge.source === "a");
  assert.equal(edge.evidence_count, 2);
  assert.equal(edge.evidence.length, 2);
  assert.equal(merge(result, second).edges[0].evidence_count, 2);
  assert.equal(result.view_full, false);
});

test("progressive views cap nodes and links without dangling endpoints", () => {
  const nodes = Array.from({length:200}, (_,i)=>({key:`n-${i}`}));
  const edges = nodes.slice(1).map((node)=>({source:"n-0",target:node.key,relation:"shared_credit"}));
  const result = context.CatalogGraph.merge({nodes:[],edges:[]},{nodes,edges});
  assert.equal(result.nodes.length,180);
  assert.equal(result.view_full,true);
  const retained = new Set(result.nodes.map((node)=>node.key));
  assert.ok(result.edges.every((edge)=>retained.has(edge.source)&&retained.has(edge.target)));
});

test("mixed graph merges preserve credit, album and genre edge direction", () => {
  const graph = {
    scope:"catalog",
    nodes:[{key:"z-song",kind:"song"},{key:"a-album",kind:"album"},{key:"b-artist",kind:"artist"},{key:"genre:electronic",kind:"genre"}],
    edges:[
      {source:"z-song",target:"a-album",relation:"album"},
      {source:"z-song",target:"b-artist",relation:"artist"},
      {source:"z-song",target:"genre:electronic",relation:"genre"},
    ],
  };
  const merged = context.CatalogGraph.merge({nodes:[],edges:[]},graph);
  assert.deepEqual(merged.edges.map(({source,target,relation}) => ({source,target,relation})),graph.edges);
  const elements = context.CatalogGraph.elements(merged);
  assert.equal(elements.filter(element => element.group === "nodes" && element.data.kind === "genre").length,1);
  assert.ok(elements.filter(element => element.group === "edges").every(edge => edge.data.source === "node:z-song"));
});

test("atlas groups retain counts, internal relationship loops and zoom-to-expand", async () => {
  const graph = {
    scope:"atlas",
    nodes:[{key:"atlas:deezer:song:",title:"Songs",kind:"song",count:30000,group:{source:"deezer",kind:"song",prefix:""}}],
    edges:[{source:"atlas:deezer:song:",target:"atlas:deezer:song:",relation:"album",count:200}],
  };
  const elements = context.CatalogGraph.elements(graph);
  assert.match(elements[0].data.label,/30,000 records/);
  assert.equal(elements[0].data.grouped,1);
  assert.equal(elements.filter(element => element.group === "edges").length,1);
  const expanded = [];
  const view = new context.CatalogGraphView({style:{},addEventListener(){}},{
    inspect(){},connection(){},selection(){},tooltip(){},status(){},zoomExpand:(key)=>expanded.push(key),
  });
  try {
    view.cy.width = () => 800;
    view.cy.height = () => 600;
    view.update(graph,null);
    view.cy.nodes().first().position({x:400,y:300});
    view.cy.zoom(.5);
    view.zoomBaseline = .5;
    view.cy.zoom(1);
    view.cy.pan({x:0,y:0});
    await new Promise(resolve=>setTimeout(resolve,450));
    assert.deepEqual(expanded,["atlas:deezer:song:"]);
    view.setSpacing(2.4);
    assert.equal(view.spacing,2.4);
    view.update({scope:"catalog",nodes:[],edges:[]},null);
    assert.equal(view.atlas,false);
  } finally { clearTimeout(view.zoomTimer); view.cy.destroy(); }
});
