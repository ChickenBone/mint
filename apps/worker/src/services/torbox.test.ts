import assert from "node:assert/strict";
import test from "node:test";
import { jobId } from "@mint/core";
import * as torbox from "./torbox";

test("TorBox torrent and Usenet API contracts remain separate and validate submission IDs", async (t) => {
  const originalKey = process.env.TORBOX_API_KEY;
  process.env.TORBOX_API_KEY = "fixture-only";
  t.after(() => {
    if (originalKey === undefined) delete process.env.TORBOX_API_KEY;
    else process.env.TORBOX_API_KEY = originalKey;
  });
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  let data: unknown = { usenetdownload_id: "7" };
  let success = true;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    requests.push({ url: new URL(url), init });
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-only");
    return Response.json({ success, data, error: "PLAN_REQUIRED" });
  });
  assert.equal(await torbox.addUsenet({ name: "fixture.nzb", data: Buffer.from("<nzb/>") }), 7);
  assert.equal(requests[0]!.url.pathname, "/v1/api/usenet/createusenetdownload");
  const file = (requests[0]!.init!.body as FormData).get("file") as File;
  assert.equal(file.name, "fixture.nzb");
  assert.equal(await file.text(), "<nzb/>");
  for (const invalid of ["", "invalid", "1.5", "-1", "0", "9007199254740992"]) {
    data = { usenetdownload_id: invalid };
    await assert.rejects(torbox.addUsenet({ name: "bad.nzb", data: Buffer.from("fixture") }), /invalid Usenet download ID/);
  }
  data = { torrent_id: 7, hash: "fixture" };
  await torbox.addTorrent({ magnet: "magnet:?xt=fixture" }, "fixture");
  assert.equal(requests.at(-1)!.url.pathname, "/v1/api/torrents/createtorrent");
  data = { id: 7 };
  assert.deepEqual(await torbox.getUsenet(7), { id: 7 });
  assert.equal(requests.at(-1)!.url.searchParams.get("id"), "7");
  assert.equal(requests.at(-1)!.url.searchParams.get("bypass_cache"), "true");
  data = "https://download.test/fixture";
  assert.equal(await torbox.usenetFileLink(7, 2), data);
  assert.equal(requests.at(-1)!.url.searchParams.get("usenet_id"), "7");
  assert.equal(requests.at(-1)!.url.searchParams.get("torrent_id"), null);
  assert.equal(requests.at(-1)!.url.searchParams.get("file_id"), "2");
  assert.equal(requests.at(-1)!.url.searchParams.get("redirect"), "false");
  await torbox.fileLink(7, 2);
  assert.equal(requests.at(-1)!.url.searchParams.get("torrent_id"), "7");
  await torbox.removeUsenet(7);
  assert.deepEqual(JSON.parse(String(requests.at(-1)!.init!.body)), { usenet_id: 7, operation: "delete" });
  await torbox.removeTorrent(7);
  assert.deepEqual(JSON.parse(String(requests.at(-1)!.init!.body)), { torrent_id: 7, operation: "delete" });
  success = false;
  await assert.rejects(torbox.getUsenet(7), /PLAN_REQUIRED/);
  await assert.rejects(torbox.removeUsenet(7), /PLAN_REQUIRED/);
  await assert.rejects(torbox.removeTorrent(7), /PLAN_REQUIRED/);
  assert.equal(jobId.torbox(7), "torbox-7", "old persisted torrent job IDs must remain valid");
  assert.equal(jobId.torbox(7, "torrent"), "torbox-7");
  assert.equal(jobId.torbox(7, "usenet"), "torbox-usenet-7");
});
