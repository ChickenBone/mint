"use strict";

globalThis.CatalogGraph = {
  merge(previous, incoming) {
    const records = new Map(), aliases = new Map();
    for (const record of [...previous.nodes, ...incoming.nodes]) {
      const identity = record.canonical_id || record.key;
      aliases.set(record.key, identity);
      if (!records.has(identity)) records.set(identity, record);
    }
    const nodes = [...records.values()].slice(0, 180);
    const retained = new Map(nodes.map((record) => [record.canonical_id || record.key, record.key]));
    const relationships = new Map();
    for (const edge of [...previous.edges, ...incoming.edges]) {
      const source = retained.get(aliases.get(edge.source));
      const target = retained.get(aliases.get(edge.target));
      if (!source || !target || source === target) continue;
      const pair = edge.relation === "shared_credit" ? [source, target].sort() : [source, target];
      const id = JSON.stringify([pair, edge.relation]);
      const old = relationships.get(id);
      const evidence = new Map([...(old?.evidence || []), ...(edge.evidence || [])].map((record) => [record.key, record]));
      relationships.set(id, { ...edge, source: pair[0], target: pair[1], evidence: [...evidence.values()].slice(0, 5), evidence_count: Math.max(evidence.size, old?.evidence_count || 0, edge.evidence_count || 0), evidence_truncated: evidence.size > 5 || old?.evidence_truncated || edge.evidence_truncated });
    }
    const capped = records.size > 180 || relationships.size > 400;
    return { ...incoming, nodes, edges: [...relationships.values()].slice(0, 400), view_full: capped, truncated: incoming.truncated || previous.truncated || capped };
  },
  elements(graph) {
    const records = new Map(graph.nodes.map((record) => [record.key, record]));
    const edges = new Map(), degree = new Map();
    for (const edge of graph.edges) {
      if (!records.has(edge.source) || !records.has(edge.target) || (edge.source === edge.target && graph.scope !== "atlas")) continue;
      const endpoints = edge.relation === "shared_credit" ? [edge.source, edge.target].sort() : [edge.source, edge.target];
      const id = JSON.stringify(["edge", ...endpoints, edge.relation]);
      if (edges.has(id)) continue;
      edges.set(id, { group: "edges", data: {
        id, source: `node:${edge.source}`, target: `node:${edge.target}`,
        relation: edge.relation, record: edge,
        weight: Math.min(5, Math.max(1, edge.count ? Math.log10(edge.count + 1) : edge.evidence_count || 1)),
      } });
      for (const key of endpoints) degree.set(key, (degree.get(key) || 0) + 1);
    }
    return [...records.values()].map((record) => ({
      group: "nodes",
      data: {
        id: `node:${record.key}`, key: record.key, label: record.group ? `${record.title}\n${Number(record.count).toLocaleString()} ${record.kind === "genre" ? record.count === 1 ? "tag" : "tags" : record.count === 1 ? "record" : "records"}` : record.title || record.key,
        kind: record.kind || "artist", record, degree: degree.get(record.key) || 0,
        grouped: record.group ? 1 : 0,
        size: record.group ? 44 + Math.min(28, Math.log10(record.count + 1) * 8) : 24 + Math.min(18, Math.sqrt(degree.get(record.key) || 0) * 5),
      },
    })).concat([...edges.values()]);
  },
};
