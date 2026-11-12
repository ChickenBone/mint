import assert from "node:assert/strict";
import test from "node:test";
import { dynamic, GET } from "../src/app/worker.yml/route";

test("downloaded worker Compose uses runtime deployment configuration and supports .env URL overrides", async () => {
  const previous = process.env.PUBLIC_URL;
  try {
    assert.equal(dynamic, "force-dynamic");
    for (const origin of ["https://mint.chickenbone.dev", "https://music.example.net"]) {
      process.env.PUBLIC_URL = origin;
      const response = GET(), source = await response.text();
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.ok(source.includes(`MINT_URL: \${MINT_URL:-${origin}}`));
      assert.ok(source.includes(`https://${new URL(origin).hostname}/app/workers`));
      assert.ok(!source.includes("localhost"));
      assert.ok(source.includes("Audio analysis uses a separate"));
      assert.ok(source.includes("image: ${COBALT_IMAGE:-ghcr.io/imputnet/cobalt:11}"));
      assert.ok(source.includes("CUSTOM_INNERTUBE_CLIENT: ${COBALT_INNERTUBE_CLIENT:-IOS}"));
      assert.ok(source.includes("docs/self-hosting.md#cobalt"));
    }
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_URL; else process.env.PUBLIC_URL = previous;
  }
});
