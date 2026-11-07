import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const revision = "7536deb1d528508d5ec3ee2f710f9c98c764fb01";
const [action, directory, confirmation, ...extra] = process.argv.slice(2);
const actions = ["prepare", "config", "build", "import", "start", "index"];
if (!actions.includes(action) || !directory || extra.length ||
  (action === "import" ? confirmation !== "--accept-large-download-and-license" : confirmation !== undefined)) {
  console.error("Usage: node deploy/docker/musicbrainz.mjs prepare|config|build|start|index <new-relative-directory>");
  console.error("Import only: node deploy/docker/musicbrainz.mjs import <directory> --accept-large-download-and-license");
  process.exit(1);
}
if (path.isAbsolute(directory) || directory.split(/[\\/]/).includes("..")) {
  throw new Error("Use a project-relative directory without parent traversal.");
}
const root = path.resolve(directory);
const env = { ...process.env };
// Do not inherit Mint's Compose files/profiles or provider environment into the upstream project.
for (const key of ["COMPOSE_FILE", "COMPOSE_PROFILES", "COMPOSE_PROJECT_NAME"]) delete env[key];
const run = (command, args, cwd = root, capture = false) =>
  execFileSync(command, args, { cwd, env, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", encoding: "utf8" });
const compose = (...args) => run("docker", ["compose", "--project-name", "mint-musicbrainz", ...args]);

if (action === "prepare") {
  if (existsSync(root)) throw new Error("Refusing to overwrite an existing upstream directory.");
  run("git", ["clone", "--no-checkout", "https://github.com/metabrainz/musicbrainz-docker.git", directory], process.cwd());
  run("git", ["checkout", "--detach", revision]);
  mkdirSync(path.join(root, "local/compose"), { recursive: true });
  copyFileSync(new URL("./musicbrainz-network.yml", import.meta.url), path.join(root, "local/compose/mint-network.yml"));
  writeFileSync(path.join(root, ".env"), "MUSICBRAINZ_WEB_SERVER_HOST=musicbrainz-mirror\nMUSICBRAINZ_WEB_SERVER_PORT=5000\n", { mode: 0o600, flag: "wx" });
  run("bash", ["admin/configure", "add", "local/compose/mint-network.yml"]);
  writeFileSync(path.join(root, ".mint-upstream-revision"), `${revision}\n`, { flag: "wx" });
}
if (readFileSync(path.join(root, ".mint-upstream-revision"), "utf8").trim() !== revision ||
  run("git", ["rev-parse", "HEAD"], root, true).trim() !== revision) {
  throw new Error("Upstream revision changed; review upgrade instructions before changing the provisioner pin.");
}
compose("config", "--quiet");
if (action === "config" || action === "prepare") {
  console.info(`Pinned upstream ${revision} configured. No images built, data imported or containers started.`);
} else if (action === "build") {
  compose("build");
} else {
  if (action === "import" && existsSync(path.join(root, ".mint-import-completed"))) {
    throw new Error("Import already completed; refusing to reinitialize an existing mirror. Use upstream replication/upgrade instructions.");
  }
  if (action === "start" && !existsSync(path.join(root, ".mint-import-completed"))) {
    throw new Error("Run the explicit import step successfully before starting the mirror.");
  }
  let internal;
  try { internal = run("docker", ["network", "inspect", "--format", "{{.Internal}}", "mint_metadata"], root, true).trim(); }
  catch { run("docker", ["network", "create", "--internal", "mint_metadata"]); }
  if (internal !== undefined && internal !== "true") throw new Error("Existing mint_metadata network is not internal; refusing to change or reuse it.");
  if (action === "import") {
    console.info("Explicit full metadata download/import: includes CC BY-NC-SA dumps; hundreds of GB may be required.");
    compose("run", "--rm", "musicbrainz", "createdb.sh", "-fetch");
    writeFileSync(path.join(root, ".mint-import-completed"), `${revision}\n`);
  } else if (action === "start") {
    compose("up", "-d");
  } else {
    compose("exec", "indexer", "python", "-m", "sir", "reindex");
  }
}
