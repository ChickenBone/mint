import { createHash, createPrivateKey, randomUUID, sign, verify, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { basename, extname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const types = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", svg: "image/svg+xml",
  ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2",
  mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "video/mp4", json: "application/json",
};

export function updateOrigin(updateUrl) {
  const url = new URL(updateUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/api/updates") {
    throw new Error("MINT_OTA_URL must be a public HTTPS origin followed by /api/updates, without credentials/query/hash.");
  }
  return url.origin;
}

export function signingCertificate(certificatePem, now = new Date()) {
  const certificate = new X509Certificate(certificatePem);
  const details = execFileSync("openssl", ["x509", "-noout", "-text"], { input: certificatePem, encoding: "utf8" });
  if (certificate.publicKey.asymmetricKeyType !== "rsa" ||
      certificate.publicKey.asymmetricKeyDetails.modulusLength < 2048 ||
      !certificate.verify(certificate.publicKey) ||
      !certificate.keyUsage?.includes("1.3.6.1.5.5.7.3.3") ||
      !/X509v3 Key Usage:[^\n]*\n\s+Digital Signature(?:,|\s*$)/m.test(details) ||
      now < new Date(certificate.validFrom) || now > new Date(certificate.validTo)) {
    throw new Error("OTA requires a valid self-signed RSA certificate (2048+ bits) with Digital Signature and Code Signing usages.");
  }
  return certificate;
}

export async function createPublication({ directory, updateUrl, runtime, channel, certificatePem, privateKeyPem, config = {}, now = new Date() }) {
  const origin = updateOrigin(updateUrl);
  if (!/^[a-f0-9]{64}$/.test(runtime) || !["production", "preview"].includes(channel)) {
    throw new Error("OTA publication requires the exact Android native runtime and an allowed channel.");
  }
  const certificate = signingCertificate(certificatePem, now);
  const privateKey = createPrivateKey(privateKeyPem);
  if (certificate.publicKey.asymmetricKeyType !== "rsa" || privateKey.asymmetricKeyType !== "rsa" ||
      certificate.publicKey.asymmetricKeyDetails.modulusLength < 2048 ||
      now < new Date(certificate.validFrom) || now > new Date(certificate.validTo)) {
    throw new Error("OTA signing requires a valid RSA certificate/key (at least 2048 bits).");
  }
  const root = await realpath(directory);
  const metadata = JSON.parse(await readFile(resolve(root, "metadata.json"), "utf8"));
  const android = metadata.fileMetadata?.android;
  if (metadata.version !== 0 || metadata.bundler !== "metro" || !android?.bundle || !Array.isArray(android.assets)) {
    throw new Error("Unsupported Expo Android export metadata; refusing to publish an incomplete update.");
  }
  if (android.assets.length > 512) throw new Error("OTA export exceeds the 512-asset server limit.");
  const uploads = new Map();
  async function asset(path, extension, launch = false) {
    if (typeof path !== "string") throw new Error("Invalid OTA asset path.");
    const file = await realpath(resolve(root, path));
    const confined = relative(root, file);
    if (confined.startsWith("../") || confined === ".." || confined.startsWith("/")) {
      throw new Error("OTA export asset escapes its export directory.");
    }
    const bytes = await readFile(file);
    if (!bytes.length || bytes.length > MAX_ASSET_BYTES) throw new Error(`Invalid OTA asset size: ${path}.`);
    const digest = createHash("sha256").update(bytes).digest();
    const hex = digest.toString("hex");
    const contentType = launch ? "application/javascript" : (types[extension] ?? "application/octet-stream");
    const previous = uploads.get(hex);
    if (previous && previous.contentType !== contentType) throw new Error("Identical OTA asset has conflicting MIME types.");
    uploads.set(hex, { hex, bytes, contentType });
    return {
      key: basename(path, launch ? extname(path) : undefined),
      hash: digest.toString("base64url"),
      contentType,
      fileExtension: launch ? ".hbc" : `.${extension}`,
      url: `${origin}/api/updates/assets/${hex}`,
    };
  }
  const launchAsset = await asset(android.bundle, "hbc", true);
  const assets = [];
  for (const item of android.assets) {
    if (!/^[a-zA-Z0-9]{1,16}$/.test(item.ext)) throw new Error("Invalid OTA asset extension.");
    assets.push(await asset(item.path, item.ext));
  }
  const manifest = JSON.stringify({
    id: randomUUID(), createdAt: now.toISOString(), runtimeVersion: runtime,
    launchAsset, assets, metadata: { channel, platform: "android" },
    extra: { expoClient: config },
  });
  const signature = sign("RSA-SHA256", Buffer.from(manifest), privateKey).toString("base64");
  if (!verify("RSA-SHA256", Buffer.from(manifest), certificate.publicKey, Buffer.from(signature, "base64"))) {
    throw new Error("OTA private key does not match the embedded signing certificate.");
  }
  const body = JSON.stringify({ channel, platform: "android", keyid: "main", manifest, signature });
  if (Buffer.byteLength(body) > 1024 * 1024) throw new Error("OTA manifest exceeds the server publication limit.");
  return { body, uploads: [...uploads.values()], manifest: JSON.parse(manifest), certificate };
}

export async function publishUpdate({ publication, updateUrl, token, request = fetch }) {
  if (!token || token.length < 32) throw new Error("Missing/short OTA_PUBLISH_TOKEN; configure a random 32-byte or stronger publisher secret.");
  const origin = updateOrigin(updateUrl);
  async function send(path, options) {
    const response = await request(`${origin}${path}`, {
      ...options, redirect: "error", signal: AbortSignal.timeout(120000),
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`OTA publication failed (${response.status}) at ${path}; existing update remains active.`);
    return response;
  }
  for (const upload of publication.uploads) {
    await send(`/api/updates/publish/assets/${upload.hex}`, {
      method: "PUT", headers: { "Content-Type": upload.contentType }, body: upload.bytes,
    });
  }
  await send("/api/updates/publish", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: publication.body,
  });
  const response = await request(updateUrl, {
    redirect: "error", signal: AbortSignal.timeout(30000),
    headers: {
      "expo-protocol-version": "1", "expo-platform": "android",
      "expo-runtime-version": publication.manifest.runtimeVersion,
      "expo-channel-name": publication.manifest.metadata.channel,
      "expo-expect-signature": 'sig, keyid="main", alg="rsa-v1_5-sha256"',
      "Cache-Control": "no-cache",
    },
  });
  if (!response.ok) throw new Error(`Published OTA manifest could not be read back (${response.status}).`);
  const manifest = await response.text();
  const signature = response.headers.get("expo-signature")?.match(/(?:^|,\s*)sig="([^"]+)"/)?.[1];
  if (!signature || !verify("RSA-SHA256", Buffer.from(manifest), publication.certificate.publicKey, Buffer.from(signature, "base64")) ||
      JSON.parse(manifest).id !== publication.manifest.id) {
    throw new Error("OTA read-back signature/update ID did not match the published update.");
  }
  return publication.manifest;
}

async function main() {
  if (process.argv[2] === "configuration") {
    updateOrigin(process.env.MINT_OTA_URL);
    signingCertificate(await readFile(resolve("apps/mobile", process.env.MINT_OTA_CERTIFICATE_PATH), "utf8"));
    console.log("Validated public self-hosted OTA URL and SDK58-compatible code-signing certificate.");
    return;
  }
  for (const name of ["MINT_OTA_URL", "MINT_NATIVE_RUNTIME", "MINT_OTA_CHANNEL", "OTA_SIGNING_PRIVATE_KEY_PEM", "MINT_OTA_CERTIFICATE_PATH"]) {
    if (!process.env[name]) throw new Error(`Missing ${name}; see docs/android-builds.md.`);
  }
  const publication = await createPublication({
    directory: ".android-ci/export", updateUrl: process.env.MINT_OTA_URL,
    runtime: process.env.MINT_NATIVE_RUNTIME, channel: process.env.MINT_OTA_CHANNEL,
    certificatePem: await readFile(resolve("apps/mobile", process.env.MINT_OTA_CERTIFICATE_PATH), "utf8"),
    privateKeyPem: process.env.OTA_SIGNING_PRIVATE_KEY_PEM,
    config: JSON.parse(await readFile(".android-ci/expo-config.json", "utf8")),
  });
  await writeFile(".android-ci/publication.json", `${publication.body}\n`);
  if (process.env.PUBLISH_OTA === "true") {
    await publishUpdate({ publication, updateUrl: process.env.MINT_OTA_URL, token: process.env.OTA_PUBLISH_TOKEN });
    console.log(`Published signed Android OTA ${publication.manifest.id} for runtime ${publication.manifest.runtimeVersion}.`);
  } else {
    console.log("Signed OTA artifact prepared; remote publication disabled (set repository variable OTA_PUBLISH_ENABLED=true).");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
