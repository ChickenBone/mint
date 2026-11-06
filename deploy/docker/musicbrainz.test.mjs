import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const script = new URL("./musicbrainz.mjs", import.meta.url).pathname;
const revision = "7536deb1d528508d5ec3ee2f710f9c98c764fb01";

test("upstream provisioner separates configuration/start from explicit, non-repeatable data import", () => {
  const root = mkdtempSync(path.join(process.cwd(), ".mint-musicbrainz-test-"));
  try {
    mkdirSync(path.join(root, "bin"));
    mkdirSync(path.join(root, "upstream"));
    writeFileSync(path.join(root, "upstream/.mint-upstream-revision"), revision);
    const executable = (name, code) => {
      const file = path.join(root, "bin", name);
      writeFileSync(file, `#!${process.execPath}\n${code}\n`);
      chmodSync(file, 0o755);
    };
    executable("git", `console.log(process.env.FAKE_REVISION || "${revision}")`);
    executable("docker", `
      const fs = require("node:fs");
      const args = process.argv.slice(2);
      fs.appendFileSync("commands.jsonl", JSON.stringify(args) + "\\n");
      if (args[0] === "network" && args[1] === "inspect") {
        if (process.env.FAKE_NETWORK === "missing") process.exit(1);
        console.log(process.env.FAKE_NETWORK || "true");
      }
      if (process.env.FAKE_IMPORT_FAILED === "true" && args.includes("createdb.sh")) process.exit(1);
    `);
    const run = (args, extra = {}) => spawnSync(process.execPath, [script, ...args], {
      cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, ...extra },
    });
    const log = path.join(root, "upstream/commands.jsonl");
    const commands = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    const clear = () => { if (existsSync(log)) rmSync(log); };

    assert.notEqual(run(["import", "upstream"]).status, 0);
    assert.deepEqual(commands(), []);
    assert.equal(run(["config", "upstream"]).status, 0);
    assert.deepEqual(commands(), [["compose", "--project-name", "mint-musicbrainz", "config", "--quiet"]]);
    clear();
    assert.equal(run(["build", "upstream"]).status, 0);
    assert.equal(commands().some((args) => args.join(" ") === "compose --project-name mint-musicbrainz build"), true);
    assert.equal(commands().some((args) => args.includes("createdb.sh")), false);
    clear();
    assert.notEqual(run(["start", "upstream"]).status, 0);
    assert.equal(commands().some((args) => args.includes("up")), false);
    clear();
    assert.notEqual(run(["import", "upstream", "--accept-large-download-and-license"], { FAKE_NETWORK: "false" }).status, 0);
    assert.equal(commands().some((args) => args.includes("createdb.sh")), false);
    clear();
    assert.equal(run(["index", "upstream"]).status, 0);
    assert.equal(commands().some((args) => args.join(" ") === "compose --project-name mint-musicbrainz exec indexer python -m sir reindex"), true);
    assert.equal(commands().some((args) => args.includes("createdb.sh")), false);
    clear();
    assert.notEqual(run(["import", "upstream", "--accept-large-download-and-license"], { FAKE_IMPORT_FAILED: "true" }).status, 0);
    assert.equal(existsSync(path.join(root, "upstream/.mint-import-completed")), false);
    clear();
    assert.equal(run(["import", "upstream", "--accept-large-download-and-license"], { FAKE_NETWORK: "missing" }).status, 0);
    assert.equal(commands().some((args) => args.join(" ") === "network create --internal mint_metadata"), true);
    assert.equal(commands().some((args) => args.includes("createdb.sh") && args.includes("-fetch")), true);
    assert.equal(existsSync(path.join(root, "upstream/.mint-import-completed")), true);
    clear();
    assert.notEqual(run(["import", "upstream", "--accept-large-download-and-license"]).status, 0);
    assert.equal(commands().some((args) => args.includes("createdb.sh")), false);
    clear();
    assert.equal(run(["start", "upstream"]).status, 0);
    assert.equal(commands().some((args) => args.join(" ") === "compose --project-name mint-musicbrainz up -d"), true);
    assert.equal(commands().some((args) => args.includes("createdb.sh")), false);
    clear();
    assert.notEqual(run(["config", "upstream"], { FAKE_REVISION: "different" }).status, 0);
    assert.deepEqual(commands(), []);
    assert.notEqual(run(["prepare", "upstream"]).status, 0);
    assert.notEqual(run(["prepare", "../outside"]).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
