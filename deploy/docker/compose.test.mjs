import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const source = readFileSync(new URL("../../docker-compose.nas.yml", import.meta.url), "utf8");
const docker = process.env.COMPOSE_DOCKER_BINARY || "docker";
const resolve = (yaml, env = {}) =>
  JSON.parse(
    execFileSync(docker, ["compose", "--project-name", "mint-test", "-f", "-", "config", "--format", "json"], {
      input: yaml,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    }),
  );

test("Cobalt opt-in image and client preserve private defaults across CLI, NAS and volunteer setup", () => {
  const cli = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
  const agent = readFileSync(new URL("../../docker-compose.agent.yml", import.meta.url), "utf8");
  for (const yaml of [cli, agent]) {
    const defaults = resolve(yaml, { MINT_WORKER_TOKEN: "fixture-only-worker-token" }).services.cobalt;
    assert.equal(defaults.image, "ghcr.io/imputnet/cobalt:11");
    assert.equal(defaults.environment.CUSTOM_INNERTUBE_CLIENT, "IOS");
    assert.equal(defaults.ports, undefined);
    const optedIn = resolve(yaml, { MINT_WORKER_TOKEN: "fixture-only-worker-token",
      COBALT_IMAGE: "mint-cobalt:pr1581-2e8c384", COBALT_INNERTUBE_CLIENT: "VISIONOS" }).services.cobalt;
    assert.equal(optedIn.image, "mint-cobalt:pr1581-2e8c384");
    assert.equal(optedIn.environment.CUSTOM_INNERTUBE_CLIENT, "VISIONOS");
    assert.equal(optedIn.environment.API_URL, defaults.environment.API_URL);
    assert.deepEqual(optedIn.networks, defaults.networks);
    assert.equal(optedIn.ports, undefined);
  }
  const nas = resolve(source).services.cobalt;
  assert.equal(nas.image, "ghcr.io/imputnet/cobalt:11");
  assert.equal(nas.environment.CUSTOM_INNERTUBE_CLIENT, undefined, "NAS remains explicitly edited, not .env-dependent");
  assert.equal(nas.ports, undefined);
  assert.deepEqual(Object.keys(nas.networks), ["media"]);
});

test("authorized YouTube metadata matching is opt-in and reaches web and pipeline worker", () => {
  const cli = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
  for (const [value, expected] of [["", "false"], ["true", "true"]]) {
    const { services } = resolve(cli, { YOUTUBE_SCRAPE_AUTHORIZED: value });
    assert.equal(services.web.environment.YOUTUBE_SCRAPE_AUTHORIZED, expected);
    assert.equal(services.worker.environment.YOUTUBE_SCRAPE_AUTHORIZED, expected);
    assert.equal(services.hub.environment.YOUTUBE_SCRAPE_AUTHORIZED, undefined);
  }
  for (const [value, expected] of [["false", "false"], ["true", "true"]]) {
    const yaml = source.replace('&youtube-scrape-authorized "false"', `&youtube-scrape-authorized "${value}"`);
    const { services } = resolve(yaml);
    assert.equal(services.web.environment.YOUTUBE_SCRAPE_AUTHORIZED, expected);
    assert.equal(services.worker.environment.YOUTUBE_SCRAPE_AUTHORIZED, expected);
    assert.equal(services.hub.environment.YOUTUBE_SCRAPE_AUTHORIZED, undefined);
  }
});

test("Docker release ignores only mobile-only branch pushes, preserving shared and mixed changes", () => {
  const release = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
  const triggers = release.match(/^on:\n([\s\S]*?)^\S/m)?.[1];
  assert.ok(triggers);
  assert.match(triggers, /^  push:\n    branches: \[main\]\n    tags: \["v\*"\]/m);
  assert.match(triggers, /^  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(triggers, /^  workflow_run:|^    paths:/m);
  const ignored = [...triggers.matchAll(/^      - "([^"]+)"$/gm)].map(match => match[1]);
  assert.deepEqual(ignored, [
    "apps/mobile/**",
    "deploy/mobile/**",
    "docs/mobile.md",
    "docs/mobile-design.md",
    "docs/mobile-playback.md",
    "docs/android-builds.md",
    ".github/workflows/android-apk.yml",
  ]);
  // This allowlist uses only literal files and directory prefixes, not ordered negations.
  const mobileOnly = paths => paths.length > 0 && paths.every(file => ignored.some(pattern =>
    pattern.endsWith("/**") ? file.startsWith(pattern.slice(0, -2)) : file === pattern));
  const mobile = [
    "apps/mobile/src/playback/engine.ts",
    "apps/mobile/src/screens/settings.tsx",
    "apps/mobile/plugins/with-android-audio.js",
    "apps/mobile/package.json",
    "deploy/mobile/eas-distribution.mjs",
    "docs/mobile.md",
    "docs/mobile-design.md",
    "docs/mobile-playback.md",
    "docs/android-builds.md",
    ".github/workflows/android-apk.yml",
  ];
  assert.equal(mobileOnly(mobile), true);
  for (const file of [
    "packages/client/src/index.ts",
    "packages/client/package.json",
    "packages/core/src/playback.ts",
    "packages/core/migrations/0020_example.sql",
    "apps/web/src/app/api/native/route.ts",
    "apps/web/src/components/app/player.tsx",
    "apps/worker/src/index.ts",
    "apps/realtime/src/index.ts",
    "apps/agent/src/index.ts",
    "services/chart-source/main.mts",
    "package.json",
    "package-lock.json",
    "tsconfig.base.json",
    ".npmrc",
    "patches/shared.patch",
    "Dockerfile",
    ".dockerignore",
    "docker-compose.yml",
    "deploy/docker/entrypoint.sh",
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    "docs/self-hosting.md",
    "docs/mobile-api.md",
    "apps/mobile-other/index.ts",
  ]) {
    assert.equal(mobileOnly([file]), false, file);
    assert.equal(mobileOnly([...mobile, file]), false, `mixed change: ${file}`);
  }
  // GitHub compares changed paths, including deleted files and both sides of renames.
  assert.equal(mobileOnly(["apps/mobile/src/deleted.ts"]), true);
  assert.equal(mobileOnly(["apps/web/src/deleted.ts"]), false);
  assert.equal(mobileOnly(["apps/mobile/src/moved.ts", "packages/client/src/moved.ts"]), false);

  const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const ciTriggers = ci.match(/^on:\n([\s\S]*?)^\S/m)?.[1];
  assert.ok(ciTriggers);
  assert.match(ciTriggers, /^  pull_request:\s*$/m);
  assert.match(ciTriggers, /^  push:\n    branches: \[main\]/m);
  assert.doesNotMatch(ciTriggers, /paths(?:-ignore)?:/);
  for (const command of ["npm run agents:check", "npm run typecheck", "npm run lint", "npm test", "npm run build"]) {
    assert.ok(ci.includes(`- run: ${command}\n`), command);
  }
});

test("Expo web exact-origin allowlist reaches CLI and self-contained NAS web services", () => {
  const origin = "https://app.example.com,http://localhost:8081";
  const cli = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
  assert.equal(resolve(cli, { NATIVE_WEB_ORIGINS: origin }).services.web.environment.NATIVE_WEB_ORIGINS, origin);
  assert.equal(resolve(source).services.web.environment.NATIVE_WEB_ORIGINS, "");
  const nas = resolve(source.replace('&native-web-origins ""', `&native-web-origins "${origin}"`));
  assert.equal(nas.services.web.environment.NATIVE_WEB_ORIGINS, origin);
  assert.equal(nas.services.worker.environment.NATIVE_WEB_ORIGINS, undefined);
  assert.equal(nas.services.hub.environment.NATIVE_WEB_ORIGINS, undefined);
});

test("EAS updates need no self-hosted OTA endpoints or Compose storage", () => {
  for (const file of ["../../docker-compose.yml", "../../docker-compose.nas.yml"]) {
    const { services } = resolve(readFileSync(new URL(file, import.meta.url), "utf8"));
    assert.equal(services["ota-storage-init"], undefined);
    assert.ok(Object.keys(services.web.environment).every(key => !key.startsWith("OTA_")));
    assert.ok((services.web.volumes || []).every(mount => mount.target !== "/var/lib/mint/updates"));
  }
  for (const file of [
    "../../docker-compose.updates.yml",
    "../../apps/web/src/app/api/updates/route.ts",
    "../../apps/web/src/lib/ota-updates.ts",
  ]) assert.equal(existsSync(new URL(file, import.meta.url)), false);
});

test("separate analysis machines have configurable resources without media-server credentials or open ports", () => {
  const analysis = readFileSync(new URL("../../docker-compose.analysis.yml", import.meta.url), "utf8");
  const env = { ANALYSIS_SERVER_URL: "http://100.64.0.10:8080", ANALYSIS_WORKER_TOKEN: "fixture-only-separate-analysis-token-at-least-32" };
  const defaults = resolve(analysis, env).services.analysis;
  assert.equal(defaults.environment.ANALYSIS_CONCURRENCY, "1");
  assert.equal(defaults.ports, undefined);
  for (const key of ["DATABASE_URL", "REDIS_URL", "PLEX_TOKEN", "MINT_WORKER_TOKEN"]) assert.equal(defaults.environment[key], undefined);
  const powerful = resolve(analysis, { ...env, ANALYSIS_CONCURRENCY: "4", ANALYSIS_CPUS: "4", ANALYSIS_MEMORY_LIMIT: "3g" }).services.analysis;
  assert.equal(powerful.environment.ANALYSIS_CONCURRENCY, "4");
  assert.equal(Number(powerful.cpus), 4);
  assert.equal(Number(powerful.mem_limit), 3 * 1024 ** 3);
});

test("NAS template is self-contained and uses project-relative bind folders", () => {
  const config = resolve(source);
  assert.equal(Object.keys(config.services).length, 13);
  assert.equal(config.configs, undefined);
  for (const service of Object.values(config.services)) {
    assert.equal(service.env_file, undefined);
    assert.equal(service.build, undefined);
    for (const mount of service.volumes || []) {
      assert.equal(mount.type, "bind");
      assert.ok(mount.source);
    }
  }
});

test("chart metadata service is opt-in and isolated from secrets, media and public ports", () => {
  for (const file of ["../../docker-compose.yml", "../../docker-compose.nas.yml"]) {
    const yaml = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.equal(resolve(yaml).services["chart-source"], undefined);
    const { services } = resolve(yaml, { COMPOSE_PROFILES: "chart-source" });
    const chart = services["chart-source"];
    assert.deepEqual(chart.profiles, ["chart-source"]);
    assert.equal(chart.image.includes("mint-chart-source"), true);
    assert.equal(chart.environment.PORT, "3090");
    assert.equal(chart.environment.REDIS_URL, "redis://redis:6379");
    assert.equal(chart.environment.MINT_CHARTS_ENABLED, "true");
    assert.deepEqual(Object.keys(chart.environment).sort(), ["MINT_CHARTS_ENABLED", "PORT", "REDIS_URL"]);
    assert.equal(chart.volumes, undefined);
    assert.equal(chart.env_file, undefined);
    assert.equal(chart.ports, undefined);
    assert.equal(chart.read_only, true);
    assert.deepEqual(Object.keys(chart.networks), ["data"]);
    assert.equal(services.web.environment.MINT_CHART_SOURCE_URL, "");
    assert.equal(services.web.depends_on["chart-source"], undefined);
  }
  const cli = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
  const configured = resolve(cli, {
    COMPOSE_PROFILES: "chart-source", MINT_CHART_SOURCE_URL: "http://chart-source:3090", MINT_CHARTS_ENABLED: "false",
  });
  assert.equal(configured.services.web.environment.MINT_CHART_SOURCE_URL, "http://chart-source:3090");
  assert.equal(configured.services.web.environment.MINT_CHARTS_ENABLED, "false");
  assert.equal(configured.services["chart-source"].environment.MINT_CHARTS_ENABLED, "false");
  const nas = resolve(source.replace('&chart-source-url ""', '&chart-source-url "http://chart-source:3090"')
    .replace('&charts-enabled "true"', '&charts-enabled "false"'), { COMPOSE_PROFILES: "chart-source" });
  assert.equal(nas.services.web.environment.MINT_CHART_SOURCE_URL, "http://chart-source:3090");
  assert.equal(nas.services.web.environment.MINT_CHARTS_ENABLED, "false");
  assert.equal(nas.services["chart-source"].environment.MINT_CHARTS_ENABLED, "false");
});

test("song matching does not deploy a local model or Compose-managed provider key", () => {
  const { services, networks } = resolve(source);
  assert.equal(services.matcher, undefined);
  assert.equal(networks.matching, undefined);
  assert.equal(services.worker.environment.MATCHING_CLASSIFIER_URL, undefined);
  assert.equal(services.worker.environment.OPENAI_API_KEY, undefined);
});

test("local pipeline is enabled and existing music is mounted read-only", () => {
  const { services } = resolve(source);
  assert.equal(services.worker.environment.REMOTE_DOWNLOADS, "never");
  const original = services.worker.volumes.find((v) => v.target === "/existing-music");
  assert.equal(original.read_only, true);
  assert.equal(services.web.volumes.some((v) => v.target === "/existing-music"), false);
  assert.equal(services.init.volumes.some((v) => v.target === "/existing-music"), false);
  assert.equal(services.plex.ports[0].published, "32401");
});

test("Plex claim DNS bypass is configurable without host networking", () => {
  const { services } = resolve(source);
  assert.deepEqual(services.plex.dns, ["1.1.1.1", "8.8.8.8"]);
  assert.equal(services.plex.network_mode, undefined);
  assert.deepEqual(Object.keys(services.plex.networks), ["media"]);
  const custom = resolve(source.replace('&plex-dns ["1.1.1.1", "8.8.8.8"]', '&plex-dns ["10.0.0.1"]'));
  assert.deepEqual(custom.services.plex.dns, ["10.0.0.1"]);
});

test("migration copies explicit old volumes read-only without network or overwrites", () => {
  const migration = readFileSync(new URL("../../docker-compose.nas-migrate.yml", import.meta.url), "utf8");
  const config = resolve(migration);
  const copy = config.services.copy;
  assert.equal(copy.network_mode, "none");
  assert.equal(copy.restart, "no");
  assert.equal(copy.volumes.filter((mount) => mount.type === "volume" && mount.read_only).length, 10);
  assert.equal(copy.volumes.filter((mount) => mount.type === "bind").length, 1);
  for (const volume of Object.values(config.volumes)) assert.equal(volume.external, true);
  assert.ok(copy.command[0].includes("Refusing to overwrite"));
  assert.ok(copy.command[0].includes("cp -a"));
  assert.ok(!copy.command[0].includes("rm "));
});

test("one hostname edit reaches every public URL without exposing media keys to the hub", () => {
  const { services } = resolve(source.replace('"mint.example.com"', '"music.example.net"'));
  for (const name of ["init", "caddy", "web", "realtime", "hub", "worker"]) {
    assert.equal(services[name].environment.MINT_DOMAIN, "music.example.net");
  }
  for (const key of ["GOOGLE_CLIENT_SECRET", "TORBOX_API_KEY", "PLEX_CLAIM"]) {
    assert.equal(services.hub.environment[key], undefined);
  }
  assert.ok(services.caddy.command[0].includes("MINT_DOMAIN"));
  assert.ok(services.caddy.command[0].includes(":80 {"));
  assert.ok(services.caddy.command[0].includes("header_up Host {$$MINT_DOMAIN}"));
  assert.ok(services.caddy.command[0].includes("header_up X-Forwarded-Host {$$MINT_DOMAIN}"));
});

test("data and media remain behind the public gateway", () => {
  const { services } = resolve(source);
  for (const name of ["cloudflared", "caddy", "web", "realtime", "hub", "worker", "postgres", "redis", "cobalt"]) {
    assert.equal(services[name].ports, undefined);
  }
  assert.equal(services.lidarr.ports[0].host_ip, "127.0.0.1");
  assert.equal(services.prowlarr.ports[0].host_ip, "127.0.0.1");
  assert.deepEqual(Object.keys(services.prowlarr.networks), ["media"]);
  assert.ok(!Object.hasOwn(services.web.networks, "media"));
  assert.ok(!Object.hasOwn(services.hub.networks, "media"));
  assert.equal(services.worker.depends_on.init.condition, "service_completed_successfully");
  assert.equal(services.web.environment.PLAYBACK_WORKER_URL, "http://worker:8080");
  assert.deepEqual(Object.keys(services.web.networks), ["data", "edge"]);
  assert.equal(services.postgres.depends_on.init.condition, "service_completed_successfully");
});

test("Prowlarr auto-setup is private, persistent and configurable", () => {
  const { services } = resolve(source);
  assert.equal(services.worker.environment.PROWLARR_URL, "http://prowlarr:9696");
  assert.equal(services.worker.environment.AUTO_CONFIGURE_INDEXERS, "true");
  assert.equal(services.worker.environment.BLACKHOLE_NZB_DIR, "/blackhole/nzbs");
  assert.equal(services.worker.environment.BLACKHOLE_NZB_DOWNLOAD_DIR, "/blackhole/usenet-downloads");
  const configMount = services.prowlarr.volumes.find((v) => v.target === "/config");
  const workerMount = services.worker.volumes.find((v) => v.target === "/prowlarr-config");
  assert.equal(configMount.source, workerMount.source);
  assert.equal(workerMount.read_only, true);
  for (const name of ["web", "hub", "realtime", "cloudflared"]) {
    assert.equal(services[name].volumes?.some((v) => v.target === "/prowlarr-config") ?? false, false);
    for (const key of ["PROWLARR_API_KEY", "USENET_INDEXER_API_KEY"]) assert.equal(services[name].environment?.[key], undefined);
  }
  const disabled = resolve(source.replace('&auto-indexers "true"', '&auto-indexers "false"'));
  assert.equal(disabled.services.worker.environment.AUTO_CONFIGURE_INDEXERS, "false");
});

test("CLI stack does not leak media credentials from shared env-file into public services", () => {
  const root = mkdtempSync(path.join(process.cwd(), ".mint-compose-test-"));
  try {
    const file = path.join(root, "fixture.env");
    const composePath = docker.endsWith(".exe") && process.platform !== "win32"
      ? execFileSync("wslpath", ["-w", file], { encoding: "utf8" }).trim()
      : file;
    const keys = ["TORBOX_API_KEY", "PLEX_TOKEN", "PLEX_CLAIM", "LIDARR_API_KEY", "PROWLARR_API_KEY", "USENET_INDEXER_API_KEY", "ANALYSIS_WORKER_TOKEN", "MUSICBRAINZ_MIRROR_URL"];
    const spotifyKeys = ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"];
    writeFileSync(file, [...keys, ...spotifyKeys].map((key) => `${key}=fixture-only`).join("\n"));
    const yaml = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8").replace("path: .env", `path: ${JSON.stringify(composePath)}`);
    const { services } = resolve(yaml, Object.fromEntries([...spotifyKeys, "MUSICBRAINZ_MIRROR_URL"].map((key) => [key, "fixture-only"])));
    for (const key of keys) {
      assert.equal(services.worker.environment[key], "fixture-only");
      for (const name of ["web", "hub", "realtime"]) assert.equal(services[name].environment[key], "");
    }
    for (const key of spotifyKeys) {
      assert.equal(services.worker.environment[key], "fixture-only");
      assert.equal(services.web.environment[key], "fixture-only");
      for (const name of ["hub", "realtime"]) assert.equal(services[name].environment[key], "");
    }
    assert.equal(services.worker.volumes.find((v) => v.target === "/prowlarr-config").read_only, true);
    assert.deepEqual(Object.keys(services.prowlarr.networks), ["media"]);
    assert.equal(services.prowlarr.ports[0].host_ip, "127.0.0.1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NAS MusicBrainz mirror is optional and reaches only the private pipeline worker", () => {
  assert.equal(resolve(source).services.worker.environment.MUSICBRAINZ_MIRROR_URL, "");
  const mirrorUrl = "http://musicbrainz-mirror:5000/ws/2";
  const { services } = resolve(source.replace('&musicbrainz-mirror-url ""', `&musicbrainz-mirror-url "${mirrorUrl}"`));
  for (const [name, service] of Object.entries(services)) {
    assert.equal(service.environment?.MUSICBRAINZ_MIRROR_URL, name === "worker" ? mirrorUrl : undefined);
  }
  assert.equal(services.worker.depends_on.musicbrainz, undefined);
  assert.equal(services.musicbrainz, undefined);
});

test("checked MusicBrainz connection overlay leaves default stacks and public service boundaries intact", () => {
  const overlay = readFileSync(new URL("../../docker-compose.musicbrainz.yml", import.meta.url), "utf8");
  const config = JSON.parse(execFileSync(docker, [
    "compose", "--project-name", "mint-test", "-f", new URL("../../docker-compose.yml", import.meta.url).pathname,
    "-f", "-", "config", "--format", "json",
  ], { input: overlay, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }));
  assert.equal(config.services.worker.environment.MUSICBRAINZ_MIRROR_URL, "http://musicbrainz-mirror:5000/ws/2");
  assert.deepEqual(Object.keys(config.services.worker.networks).sort(), ["data", "media", "mint_metadata"]);
  assert.equal(config.networks.mint_metadata.external, true);
  assert.equal(config.networks.mint_metadata.name, "mint_metadata");
  assert.equal(config.services.worker.ports, undefined);
  for (const name of ["web", "hub", "realtime", "caddy", "postgres", "redis"]) {
    assert.equal(config.services[name].networks.mint_metadata, undefined);
  }
});

test("NAS Spotify credentials reach only web and the pipeline worker", () => {
  const { services } = resolve(source.replace('&spotify-id ""', '&spotify-id "fixture-only"').replace('&spotify-secret ""', '&spotify-secret "fixture-only"'));
  for (const [name, service] of Object.entries(services)) {
    for (const key of ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"]) {
      assert.equal(service.environment?.[key], ["web", "worker"].includes(name) ? "fixture-only" : undefined);
    }
  }
});

test("Cloudflare Tunnel uses HTTP internally while public URLs remain HTTPS", () => {
  const { services } = resolve(source);
  for (const name of ["web", "realtime", "hub", "worker"]) {
    assert.equal(services[name].environment.CADDY_SCHEME, undefined);
    assert.equal(services[name].environment.MINT_DOMAIN, "mint.example.com");
  }
  assert.ok(services.caddy.command[0].includes(":80 {"));
  assert.ok(!services.caddy.command[0].includes("http://{$$MINT_DOMAIN}"));
  assert.ok(!services.caddy.command[0].includes("cert_issuer"));
});

test("only the tunnel connector receives its token and cannot reach data or media", () => {
  const { services } = resolve(source.replace('&tunnel-token ""', '&tunnel-token "demo-not-a-real-token"'));
  assert.equal(services.cloudflared.environment.TUNNEL_TOKEN, "demo-not-a-real-token");
  for (const [name, service] of Object.entries(services)) {
    if (name !== "cloudflared") assert.equal(service.environment?.TUNNEL_TOKEN, undefined);
  }
  assert.deepEqual(Object.keys(services.cloudflared.networks), ["edge"]);
  assert.equal(services.cloudflared.network_mode, undefined);
  assert.deepEqual(services.cloudflared.command, ["tunnel", "--no-autoupdate", "--protocol", "http2", "run"]);
  assert.equal(services.cloudflared.read_only, true);
  assert.equal(services.cloudflared.depends_on.caddy.condition, "service_started");
});
