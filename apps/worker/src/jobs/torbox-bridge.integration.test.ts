import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("torrent and NZB blackholes submit, recover queued transfers and publish completed releases safely", {
  skip: !process.env.MINT_TORBOX_TEST_REDIS_URL,
  timeout: 30_000,
}, async (t) => {
  const url = process.env.MINT_TORBOX_TEST_REDIS_URL!;
  assert.equal(new URL(url).pathname, "/14", "use a dedicated empty Redis test database");
  const root = await mkdtemp(path.join(os.tmpdir(), "mint-torbox-test-"));
  const torrents = path.join(root, "torrents");
  const nzbs = path.join(root, "nzbs");
  const downloads = path.join(root, "downloads");
  const usenetDownloads = path.join(root, "usenet-downloads");
  Object.assign(process.env, {
    REDIS_URL: url,
    TORBOX_API_KEY: "fixture-only",
    BLACKHOLE_TORRENT_DIR: torrents,
    BLACKHOLE_NZB_DIR: nzbs,
    BLACKHOLE_DOWNLOAD_DIR: downloads,
    BLACKHOLE_NZB_DOWNLOAD_DIR: usenetDownloads,
  });
  const { getRedis } = await import("@mint/core/redis");
  const redis = getRedis();
  assert.equal(await redis.ping(), "PONG");
  assert.equal(await redis.dbsize(), 0, "refuse to run against an occupied database");
  const { queues, connection } = await import("../queues");
  const { torboxTick, getRecord, processTorboxDownload, releasePaths, downloadPath, normalizeName } = await import("./torbox-bridge");
  t.after(async () => {
    await Promise.all(Object.values(queues).map((queue) => queue.close()));
    await connection.quit();
    await redis.quit();
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([mkdir(torrents), mkdir(nzbs)]);
  await writeFile(path.join(torrents, "Legacy release.magnet"), "magnet:?xt=fixture");
  await writeFile(path.join(nzbs, "Usenet release.nzb"), "<nzb/>");
  let submissions = 0;
  const deleted: string[] = [];
  let unsafe = false;
  let rejected = false;
  let transfers = 0;
  let fileSize = 22;
  t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.hostname === "download.test") {
      transfers++;
      const bytes = Buffer.from("generated-test-fixture");
      return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
    }
    assert.equal(url.hostname, "api.torbox.app", "never make external requests in integration tests");
    const envelope = (data: unknown) => Response.json({ success: true, data });
    if (url.pathname.endsWith("/createtorrent")) {
      submissions++;
      return envelope({ torrent_id: 42 });
    }
    if (url.pathname.endsWith("/createusenetdownload")) {
      submissions++;
      assert.equal(await ((init!.body as FormData).get("file") as File).text(), rejected ? "<rejected/>" : "<nzb/>");
      if (rejected) return Response.json({ success: false, error: "PLAN_REQUIRED" });
      return envelope({ usenetdownload_id: "42" });
    }
    if (url.pathname.endsWith("/mylist")) return envelope({
      id: Number(url.searchParams.get("id")), progress: 1, download_finished: true, download_present: true, download_state: "completed",
      files: [{ id: 1, name: unsafe ? "Root/../../escape.flac" : "Root/Disc 1/fixture.flac", short_name: "fixture.flac", size: fileSize }],
    });
    if (url.pathname.endsWith("/requestdl")) return envelope("https://download.test/fixture");
    if (/\/control(?:torrent|usenetdownload)$/.test(url.pathname)) {
      deleted.push(url.pathname);
      return envelope(null);
    }
    throw new Error(`Unexpected TorBox request: ${url.pathname}`);
  });
  await torboxTick();
  assert.equal(submissions, 2);
  assert.equal((await getRecord("Legacy release"))!.phase, "local");
  assert.equal((await getRecord("Usenet release"))!.protocol, "usenet");
  let usenetJob = (await queues.torbox.getJob("torbox-usenet-42"))!;
  assert.ok(usenetJob);
  await usenetJob.remove();
  await torboxTick();
  usenetJob = (await queues.torbox.getJob("torbox-usenet-42"))!;
  assert.ok(usenetJob, "recover a local transfer lost between persisting state and queue submission");
  assert.equal(submissions, 2, "restart must not resubmit remote downloads");
  const legacyJob = (await queues.torbox.getJob("torbox-42"))!;
  assert.ok(legacyJob);
  await legacyJob.updateData({ torrentId: 42, name: "Legacy release" });
  const legacy = (await getRecord("Legacy release"))!;
  delete legacy.protocol;
  await redis.set(`mint:torbox:${normalizeName(legacy.name)}`, JSON.stringify(legacy));
  await processTorboxDownload(legacyJob);
  await processTorboxDownload(usenetJob);
  for (const name of ["Legacy release", "Usenet release"]) {
    const watchFolder = name === "Usenet release" ? usenetDownloads : downloads;
    assert.equal(await readFile(path.join(watchFolder, name, "Disc 1/fixture.flac"), "utf8"), "generated-test-fixture");
    const record = (await getRecord(name))!;
    assert.equal(record.phase, "done");
    assert.equal(record.localProgress, 1, "late progress callbacks must not overwrite completion");
  }
  assert.deepEqual(deleted.sort(), ["/v1/api/torrents/controltorrent", "/v1/api/usenet/controlusenetdownload"]);
  const previousTransfers = transfers;
  await processTorboxDownload(usenetJob);
  assert.equal(transfers, previousTransfers, "completed retries must be idempotent after remote cleanup");
  assert.equal(await redis.scard("mint:torbox:active"), 0);
  for (const name of ["", ".", "..", "../bad", "/bad", "bad\\file"]) assert.throws(() => releasePaths(name), /Unsafe/);
  for (const name of ["../bad", "root/../../escape", "/absolute", "root\\bad", "root//empty"]) {
    assert.throws(() => downloadPath(path.join(root, "partial"), name, "root"), /Unsafe/);
  }
  assert.equal(downloadPath(root, "single.flac", null), path.join(root, "single.flac"));
  assert.equal(downloadPath(root, "Disc 2/track.flac", null), path.join(root, "Disc 2/track.flac"));
  const badJob = await queues.torbox.add("download", { torrentId: 43, name: "Unsafe", protocol: "usenet" });
  unsafe = true;
  await assert.rejects(processTorboxDownload(badJob), /Unsafe path/);
  assert.equal(transfers, previousTransfers);
  await mkdir(path.join(usenetDownloads, "Occupied"));
  await writeFile(path.join(usenetDownloads, "Occupied", "original.flac"), "keep original");
  const occupiedJob = await queues.torbox.add("download", { torrentId: 44, name: "Occupied", protocol: "usenet" });
  await assert.rejects(processTorboxDownload(occupiedJob), /refusing to overwrite/);
  assert.equal(await readFile(path.join(usenetDownloads, "Occupied", "original.flac"), "utf8"), "keep original");
  unsafe = false;
  fileSize = 23;
  const badSize = await queues.torbox.add("download", { torrentId: 45, name: "Incomplete", protocol: "usenet" });
  await assert.rejects(processTorboxDownload(badSize), /file size did not match/);
  await assert.rejects(readFile(path.join(usenetDownloads, "Incomplete", "Disc 1/fixture.flac")), { code: "ENOENT" });
  fileSize = 22;
  await processTorboxDownload(badSize);
  assert.equal((await getRecord("Incomplete"))!.phase, "done");
  rejected = true;
  await writeFile(path.join(nzbs, "Rejected.nzb"), "<rejected/>");
  await torboxTick();
  assert.equal((await getRecord("Rejected"))!.phase, "error");
  assert.match((await getRecord("Rejected"))!.error!, /PLAN_REQUIRED/);
  assert.equal(await readFile(path.join(nzbs, ".mint-processed", "Rejected.nzb.failed"), "utf8"), "<rejected/>");
});
