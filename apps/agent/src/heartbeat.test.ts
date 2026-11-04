import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("the configured Mint origin receives authenticated agent heartbeats without leaking the token", { timeout: 20_000 }, async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "mint-agent-test-"));
  const token = "mint_wk_test_only_not_a_real_registration";
  let authenticated = false;
  let resolveHeartbeat!: () => void;
  const received = new Promise<void>((resolve) => { resolveHeartbeat = resolve; });
  const server = http.createServer((request, response) => {
    if (request.url === "/api/agent/v1/heartbeat") {
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      authenticated = true;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        worker: { name: "Synthetic desktop", status: "pending" }, pollMs: 15_000, heartbeatMs: 30_000,
      }));
    } else response.writeHead(200).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./index.ts", import.meta.url))], {
    env: { ...process.env, MINT_URL: origin, MINT_WORKER_TOKEN: token, COBALT_URL: origin, AGENT_WORK_DIR: workDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (output.includes("waiting for an admin")) resolveHeartbeat();
  });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([received, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Heartbeat not received: ${output}`)), 10_000);
    })]);
  } finally {
    clearTimeout(timer);
    child.kill("SIGTERM");
    await exited;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(workDir, { recursive: true, force: true });
  }
  assert.ok(output.includes(origin));
  assert.equal(authenticated, true);
  assert.ok(output.includes("waiting for an admin"));
  assert.ok(!output.includes(token));
});
