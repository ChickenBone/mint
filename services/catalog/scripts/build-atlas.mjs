import { build } from "esbuild";
import { copyFile, readFile } from "node:fs/promises";

await readFile("catalog/static/embedding-atlas.LICENSE.txt", "utf8");

// Use the official component entry: the full dashboard also embeds a SQL editor.
await build({
  stdin: {
    contents: 'export { EmbeddingView } from "embedding-atlas";',
    resolveDir: process.cwd(),
    sourcefile: "embedding-atlas-entry.js",
  },
  alias: {
    "embedding-atlas": `${process.cwd()}/node_modules/embedding-atlas/dist/component.js`,
  },
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2022",
  legalComments: "inline",
  banner: { js: "/*! Embedding Atlas 0.26.0 and bundled Svelte runtime: see embedding-atlas.LICENSE.txt */" },
  outfile: "catalog/static/embedding-atlas.js",
});
await copyFile(
  "node_modules/embedding-atlas/dist/clustering.worker.js",
  "catalog/static/clustering.worker.js",
);
