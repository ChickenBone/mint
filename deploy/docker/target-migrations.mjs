import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packages = path.join(root, "packages");
const journal = JSON.parse(readFileSync(path.join(packages, "platform/migrations/meta/_journal.json"), "utf8"));
const source = readFileSync(path.join(packages, "platform/src/startup-migrations.ts"), "utf8");
const mappings = [...source.matchAll(/\{\s*tag:\s*"([^"]+)",\s*path:\s*"([^"]+)"\s*\}/g)]
  .map(([, tag, file]) => ({ tag, file }));
if (!Array.isArray(journal.entries) || mappings.length !== journal.entries.length
  || mappings.some(({ tag }, index) => tag !== journal.entries[index]?.tag)) {
  throw new Error("Target migration mappings do not match the central journal in order");
}
for (const { file } of mappings) {
  if (!/^[a-z0-9-]+\/migrations\/[a-z0-9_-]+\.sql$/.test(file)
    || !statSync(path.join(packages, file)).isFile()) {
    throw new Error(`Missing or invalid target migration: ${file}`);
  }
}
console.log(`Validated target journal and ${mappings.length} mapped SQL files`);
