import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

function python(args) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  if (process.platform === "win32" && !process.env.PYTHON) {
    return execFileSync("docker", ["run", "--rm", "--mount", `type=bind,source=${root},target=/repo`,
      "--workdir", "/repo", "python:3.12-slim-bookworm", "python3", ...args],
    { stdio: "pipe" });
  }
  return execFileSync(process.env.PYTHON || "python3", args, { cwd: root, stdio: "pipe" });
}

test("ESXi deployment safety, maintenance admission and rollback", () => {
  python(["-B", "deploy/esxi/mint-deploy.test.py"]);
});

test("real Caddy cutover serves requests and drains audio while retaining old assets", { timeout: 180_000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mint-rollout-"));
  const file = path.join(directory, "compose.json");
  const project = `mint-rollout-test-${process.pid}`;
  const command = promisify(execFile);
  const compose = (...args) => command("docker", ["compose", "-p", project, "-f", file, ...args]);
  t.after(async () => {
    try {
      await compose("down", "--timeout", "2");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const caddy = (upstream, sha, fallback) => python(["-B", "-c", `
import importlib.util
s = importlib.util.spec_from_file_location("deploy", "deploy/esxi/mint-deploy.py")
m = importlib.util.module_from_spec(s)
s.loader.exec_module(m)
print(m.versioned_proxy("${upstream}", "${sha}", ${fallback ? `"${fallback}"` : "None"}))
`]).toString();
  const previous = caddy("web-blue", "a".repeat(40));
  const next = caddy("web-green", "b".repeat(40), "web-blue");
  await writeFile(path.join(directory, "Caddyfile"), previous);
  const backend = `
    const http = require("node:http");
    const name = process.env.NAME;
    http.createServer((req, res) => {
      if (req.url === "/stream") {
        res.write(name + "-start\\n");
        setTimeout(() => res.end(name + "-end\\n"), 4000);
      } else if (req.url === "/_next/static/old.js") {
        res.writeHead(name === "blue" ? 200 : 404);
        res.end(name === "blue" ? "old-asset" : "missing");
      } else if (req.url === "/api/missing") {
        res.writeHead(name === "blue" ? 200 : 404);
        res.end(name);
      } else {
        res.end(name);
      }
    }).listen(3000, "0.0.0.0");
  `;
  const service = name => ({ image: "node:22-alpine", environment: { NAME: name }, command: ["node", "-e", backend] });
  await writeFile(file, JSON.stringify({
    services: {
      "web-blue": service("blue"),
      "web-green": service("green"),
      caddy: {
        image: "caddy:2",
        entrypoint: ["caddy"],
        environment: { MINT_DOMAIN: "mint.example.com" },
        command: ["run", "--config", "/fixture/Caddyfile", "--adapter", "caddyfile"],
        volumes: [{ type: "bind", source: directory, target: "/fixture", read_only: true }],
        ports: [{ target: 80, published: "0", host_ip: "127.0.0.1" }],
      },
    },
  }));
  await compose("up", "-d", "--wait", "--wait-timeout", "90");
  const address = (await compose("port", "caddy", "80")).stdout.trim();
  let url = `http://${address}`;
  const request = route => new Promise((resolve, reject) => {
    http.get(`${url}${route}`, { agent: false }, res => {
      let body = "";
      res.on("data", data => { body += data; });
      res.on("end", () => resolve({ status: res.statusCode, body, release: res.headers["x-mint-release"] }));
      res.on("error", reject);
    }).on("error", reject);
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      ready = (await request("/api/healthz")).body === "blue";
      if (ready) break;
    } catch (error) {
      if (i === 99) throw error;
    }
    await sleep(50);
  }
  assert.ok(ready, "fixture did not become ready");
  let started;
  const streamStarted = new Promise(resolve => { started = resolve; });
  const stream = new Promise((resolve, reject) => {
    http.get(`${url}/stream`, res => {
      let body = "";
      res.on("data", bytes => { body += bytes; started(); });
      res.on("end", () => resolve(body));
      res.on("error", reject);
    }).on("error", reject);
  });
  await streamStarted;
  const observed = [];
  let monitoring = true;
  const monitor = (async () => {
    while (monitoring) {
      observed.push(await request("/api/healthz"));
      await sleep(5);
    }
  })();
  try {
    await writeFile(path.join(directory, "Caddyfile"), next);
    await compose("exec", "-T", "caddy", "caddy", "reload", "--config", "/fixture/Caddyfile", "--adapter", "caddyfile");
    assert.equal((await request("/api/healthz")).body, "green");
    assert.equal((await request("/api/healthz")).release, "b".repeat(40));
    const probe = python(["-B", "-c", `
import importlib.util
s = importlib.util.spec_from_file_location("deploy", "deploy/esxi/mint-deploy.py")
m = importlib.util.module_from_spec(s)
s.loader.exec_module(m)
m.compose = lambda *args, **kwargs: print(args[-1])
m.probe("", "${"b".repeat(40)}", "green")
`]).toString();
    await compose("exec", "-T", "web-green", "node", "-e", probe);
    assert.equal(await stream, "blue-start\nblue-end\n", "an in-flight audio response must drain across reload");
    assert.equal((await request("/_next/static/old.js")).body, "old-asset");
    assert.equal((await request("/api/missing")).status, 404, "API failures must not replay against the old build");
  } finally {
    monitoring = false;
    await monitor;
  }
  assert.ok(observed.length >= 10, "measure availability across the cutover");
  assert.ok(observed.every(response => response.status === 200), JSON.stringify(observed));
  assert.ok(observed.some(response => response.body === "blue"));
  assert.ok(observed.some(response => response.body === "green"));
  await compose("restart", "caddy");
  url = `http://${(await compose("port", "caddy", "80")).stdout.trim()}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await request("/api/healthz")).release === "b".repeat(40)) return;
    } catch (error) {
      if (i === 99) throw error;
    }
    await sleep(50);
  }
  assert.fail("Caddy did not recover its committed configuration after restart");
});
