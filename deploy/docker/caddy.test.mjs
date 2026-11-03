import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";

test("tunnel Host headers cannot produce an empty successful response", {
  skip: !process.env.CADDY_BINARY,
  timeout: 30_000,
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mint-caddy-test-"));
  t.after(() => rm(root, { recursive: true }));
  const backend = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ path: req.url, host: req.headers.host, forwardedHost: req.headers["x-forwarded-host"] }));
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => backend.close(resolve)));
  const upstream = `127.0.0.1:${backend.address().port}`;
  const source = await readFile(new URL("../../docker-compose.nas.yml", import.meta.url), "utf8");
  const config = JSON.parse(execFileSync(process.env.COMPOSE_DOCKER_BINARY || "docker", [
    "compose", "--project-name", "mint-caddy-test", "-f", "-", "config", "--format", "json",
  ], { input: source, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }));
  const inline = config.services.caddy.command[0].match(/<<'CADDY'\n([\s\S]*?)\nCADDY/)[1]
    .replaceAll("$$", "$")
    .replaceAll("web:3000", upstream)
    .replaceAll("realtime:3001", upstream)
    .replaceAll("hub:8090", upstream);

  for (const legacy of [true, false]) {
    const reserve = http.createServer();
    await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
    const port = reserve.address().port;
    await new Promise((resolve) => reserve.close(resolve));
    const file = path.join(root, legacy ? "legacy.Caddyfile" : "fixed.Caddyfile");
    const listener = legacy ? `http://{$MINT_DOMAIN}:${port}` : `:${port}`;
    await writeFile(file, inline.replace(":80 {", `${listener} {`));
    let output = "";
    const child = spawn(process.env.CADDY_BINARY, ["run", "--config", file, "--adapter", "caddyfile"], {
      env: { ...process.env, MINT_DOMAIN: "mint.example.com", XDG_DATA_HOME: root, XDG_CONFIG_HOME: root },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (bytes) => { output += bytes; });
    child.stderr.on("data", (bytes) => { output += bytes; });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    t.after(async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      await exited;
    });
    for (let i = 0; i < 100 && !output.includes("serving initial configuration"); i++) {
      if (child.exitCode !== null) assert.fail(output);
      await sleep(20);
    }
    assert.ok(output.includes("serving initial configuration"), output);
    const request = (route, host) => new Promise((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: route, headers: { Host: host } }, (res) => {
        let body = "";
        res.on("data", (bytes) => { body += bytes; });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      req.on("error", reject);
    });
    if (legacy) {
      const blank = await request("/", "caddy");
      assert.equal(blank.status, 200);
      assert.equal(blank.body, "", "reproduces the reported blank page on the older hostname route");
    } else {
      for (const host of ["caddy", "caddy:80", "mint.example.com", "mint.chickenbone.dev"]) {
        for (const route of ["/", "/login", "/api/healthz", "/browse", "/ws", "/ingest/fixture"]) {
          const response = await request(route, host);
          assert.equal(response.status, 200);
          const body = JSON.parse(response.body);
          assert.equal(body.path, route);
          if (!route.startsWith("/ws") && !route.startsWith("/ingest/")) {
            assert.equal(body.host, "mint.example.com");
            assert.equal(body.forwardedHost, "mint.example.com");
          }
        }
      }
    }
    child.kill("SIGTERM");
    await exited;
  }
});
