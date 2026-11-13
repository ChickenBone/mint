import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = name => readFileSync(new URL(name, import.meta.url), "utf8");
const compose = read("target-api.compose.yml");

test("target journal and every mapped SQL file are present", () => {
  const output = execFileSync(process.execPath, [new URL("target-migrations.mjs", import.meta.url).pathname], { encoding: "utf8" });
  assert.match(output, /Validated target journal and \d+ mapped SQL files/);
});

test("target image uses the pnpm lock and retains workspace source and migrations", () => {
  const dockerfile = read("Dockerfile.target-api");
  assert.match(dockerfile, /pnpm install --frozen-lockfile --filter @mint\/api\.\.\./);
  assert.match(dockerfile, /RUN node deploy\/docker\/target-migrations\.mjs/);
  assert.match(dockerfile, /\/repo\/packages \/repo\/packages/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /"node", "--import", "tsx", "src\/main\.ts"/);
});

test("target gateway and API require distinct private secrets and overwrite ingress evidence", () => {
  assert.match(compose, /MINT_TARGET_API_URL: http:\/\/target-api:3002\/trpc/);
  assert.match(compose, /MINT_TARGET_TRUSTED_PROXY: authenticated-ingress/);
  assert.match(compose, /MINT_API_PUBLIC_AUTH_PROXY: gateway/);
  assert.match(compose, /header_up x-mint-ingress-token \{\$\$MINT_TARGET_INGRESS_TOKEN\}/);
  assert.match(compose, /header_up x-mint-client-ip \{remote_host\}/);
  assert.match(compose, /target-data:\s*\n\s+internal: true/);
  for (const service of ["target-api", "target-postgres"]) {
    const section = compose.split(`  ${service}:\n`)[1].split(/\n  [a-z][a-z-]+:\n/)[0];
    assert.doesNotMatch(section, /\n\s+(ports|env_file):/);
    assert.match(section, /networks: \[target-data\]/);
    assert.doesNotMatch(section, /\/music|\/secrets:ro/);
  }
  assert.match(read("target-api-entrypoint.sh"), /\/run\/secrets\/target_db_password/);
  assert.match(read("target-api-entrypoint.sh"), /\/run\/secrets\/target_gateway_token/);
  assert.match(read("target-web-entrypoint.sh"), /\/run\/secrets\/target_gateway_token/);
  assert.match(read("target-web-entrypoint.sh"), /\/run\/secrets\/target_ingress_token/);
  assert.doesNotMatch(read("target-api-entrypoint.sh"), /target_ingress_token/);
  assert.doesNotMatch(read("target-web-entrypoint.sh"), /target_db_password/);
});

test("target media overlay requires explicit paths and a non-creating read-only bind", () => {
  const media = read("target-media.compose.yml");
  assert.match(media, /MINT_TARGET_MEDIA_HOST_PATH:\?Set MINT_TARGET_MEDIA_HOST_PATH/);
  assert.match(media, /MINT_TARGET_MEDIA_CONTAINER_PATH:\?Set MINT_TARGET_MEDIA_CONTAINER_PATH/);
  assert.match(media, /read_only: true/);
  assert.match(media, /create_host_path: false/);
  assert.doesNotMatch(compose, /MINT_TARGET_MEDIA_(?:HOST|CONTAINER)_PATH/);
});
