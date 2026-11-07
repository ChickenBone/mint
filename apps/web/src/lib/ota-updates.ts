import { constants, createHash, randomUUID, timingSafeEqual, verify, X509Certificate } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";

const MiB = 1024 * 1024;
const hashPattern = /^[a-f0-9]{64}$/;
const mimePattern = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const scopeSchema = z.object({
  channel: z.enum(["production", "preview"]),
  platform: z.enum(["android", "ios"]),
});
const assetSchema = z.object({
  hash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  key: z.string().min(1).max(256),
  contentType: z.string().max(128).regex(mimePattern),
  fileExtension: z.string().regex(/^\.[A-Za-z0-9]{1,16}$/).optional(),
  url: z.string().max(2048),
}).strict();
const manifestSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime({ offset: true }),
  runtimeVersion: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  launchAsset: assetSchema,
  assets: z.array(assetSchema).max(512),
  metadata: z.record(z.string().max(128), z.string().max(256)),
  extra: z.record(z.string(), z.unknown()),
}).strict();
const publicationSchema = scopeSchema.extend({
  keyid: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  manifest: z.string().min(1).max(MiB),
  signature: z.string().min(1).max(2048).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict();
type Publication = z.infer<typeof publicationSchema>;
type Manifest = z.infer<typeof manifestSchema>;
export interface OtaConfig {
  storageDir: string;
  publicUrl: string;
  tokenHash: string;
  certificates: Record<string, string>;
  maxStorageBytes?: number;
}

class OtaError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const signatureHeader = (p: Publication) =>
  `sig="${p.signature}", keyid="${p.keyid}", alg="rsa-v1_5-sha256"`;
const scopeKey = (p: { channel: string; platform: string }, runtime: string) =>
  digest(JSON.stringify([p.channel, p.platform, runtime]));
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown; }
  catch { throw new OtaError(400, "Invalid JSON."); }
}
function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
function derItems(bytes: Buffer): { tag: number; value: Buffer }[] {
  const items: { tag: number; value: Buffer }[] = [];
  for (let offset = 0; offset < bytes.length;) {
    const tag = bytes[offset++];
    const initialLength = bytes[offset++];
    if (tag === undefined || initialLength === undefined) throw new Error("Invalid certificate DER.");
    let length = initialLength;
    if (initialLength & 0x80) {
      const count = initialLength & 0x7f;
      if (!count || count > 4 || offset + count > bytes.length) throw new Error("Invalid certificate DER length.");
      length = bytes.readUIntBE(offset, count);
      offset += count;
    }
    if (offset + length > bytes.length) throw new Error("Truncated certificate DER.");
    items.push({ tag, value: bytes.subarray(offset, offset + length) });
    offset += length;
  }
  return items;
}
function hasDigitalSignatureUsage(cert: X509Certificate): boolean {
  // Node exposes extended usages, but not X509 Key Usage; Android requires both.
  const certificate = derItems(cert.raw)[0];
  if (certificate?.tag !== 0x30) return false;
  const tbs = derItems(certificate.value)[0];
  if (tbs?.tag !== 0x30) return false;
  const extensions = derItems(tbs.value).find(item => item.tag === 0xa3);
  const sequence = extensions && derItems(extensions.value)[0];
  if (sequence?.tag !== 0x30) return false;
  for (const extension of derItems(sequence.value)) {
    if (extension.tag !== 0x30) return false;
    const fields = derItems(extension.value);
    if (fields[0]?.tag !== 0x06 || fields[0].value.toString("hex") !== "551d0f") continue;
    const encoded = fields.find(item => item.tag === 0x04);
    const bits = encoded && derItems(encoded.value)[0];
    return bits?.tag === 0x03 && bits.value.length >= 2 &&
      (bits.value[0] ?? 8) <= 7 && Boolean((bits.value[1] ?? 0) & 0x80);
  }
  return false;
}
async function optionalFile(path: string): Promise<Buffer | undefined> {
  try { return await readFile(path); }
  catch (error) { if (isErrno(error, "ENOENT")) return undefined; throw error; }
}
async function boundedBody(request: Request, limit: number): Promise<Buffer> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit))
    throw new OtaError(413, "Request exceeds the byte limit.");
  const reader = request.body?.getReader();
  if (!reader) throw new OtaError(400, "A request body is required.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new OtaError(408, "Upload timed out."));
    }, 120_000);
  });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new OtaError(413, "Request exceeds the byte limit.");
      }
      chunks.push(value);
    }
    if (!bytes) throw new OtaError(400, "An empty upload is not allowed.");
    return Buffer.concat(chunks);
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

export function createOtaHandler(config: OtaConfig) {
  const url = new URL(config.publicUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("OTA PUBLIC_URL must be a root HTTPS origin.");
  if (!isAbsolute(config.storageDir) || !hashPattern.test(config.tokenHash))
    throw new Error("OTA needs an absolute storage directory and a SHA256 publisher token hash.");
  const maxStorage = config.maxStorageBytes ?? 1024 * MiB;
  if (!Number.isSafeInteger(maxStorage) || maxStorage < 1 || maxStorage > 100 * 1024 * MiB)
    throw new Error("OTA_MAX_STORAGE_BYTES must be an integer from 1 to 107374182400.");
  const certificates = new Map<string, X509Certificate>();
  for (const [keyid, pem] of Object.entries(config.certificates)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyid)) throw new Error("Invalid OTA certificate keyid.");
    if (pem.length > 16_384) throw new Error("OTA certificate exceeds the size limit.");
    const cert = new X509Certificate(pem);
    if (cert.publicKey.asymmetricKeyType !== "rsa" ||
      (cert.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
      cert.subject !== cert.issuer || !cert.verify(cert.publicKey) ||
      !cert.keyUsage?.includes("1.3.6.1.5.5.7.3.3") || !hasDigitalSignatureUsage(cert))
      throw new Error("OTA certificates must be self-signed RSA (2048+ bits), with Digital Signature and Code Signing usages.");
    certificates.set(keyid, cert);
  }
  if (!certificates.size) throw new Error("OTA needs at least one trusted certificate.");
  const root = config.storageDir;
  const assetsDir = join(root, "assets");
  const recordsDir = join(root, "releases");
  const scopesDir = join(root, "scopes");
  const lockDir = join(root, ".publish-lock");
  const tokenHash = Buffer.from(config.tokenHash, "hex");
  const assetUrl = (hash: string) => `${url.origin}/api/updates/assets/${hash}`;

  function authorize(request: Request) {
    const authorization = request.headers.get("authorization") ?? "";
    if (authorization.length > 512 || !authorization.startsWith("Bearer ") ||
      authorization.length < 39 ||
      !timingSafeEqual(Buffer.from(digest(authorization.slice(7)), "hex"), tokenHash))
      throw new OtaError(401, "Publisher authentication required.");
    if (request.headers.has("origin")) throw new OtaError(403, "Browser publication is not allowed.");
  }
  async function locked<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    try { await mkdir(lockDir, { mode: 0o700 }); }
    catch (error) {
      if (isErrno(error, "EEXIST")) throw new OtaError(409, "Another publication is in progress; retry.");
      throw error;
    }
    try {
      await Promise.all([assetsDir, recordsDir, scopesDir].map(dir => mkdir(dir, { recursive: true, mode: 0o700 })));
      return await work();
    } finally { await rmdir(lockDir); }
  }
  async function atomicFile(path: string, bytes: Buffer) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      try { await file.writeFile(bytes); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, path);
    }
    finally {
      try { await unlink(temporary); }
      catch (error) { if (!isErrno(error, "ENOENT")) throw error; }
    }
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async function budget(additional: number) {
    let total = 0;
    let count = 0;
    for (const directory of [assetsDir, recordsDir, scopesDir]) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile()) throw new OtaError(503, "Unexpected OTA storage entry; operator inspection required.");
        if (++count > 10_000) throw new OtaError(507, "OTA storage file limit reached.");
        total += (await stat(join(directory, entry.name))).size;
      }
    }
    if (total + additional > maxStorage) throw new OtaError(507, "OTA storage byte limit reached.");
    if (count >= 9998) throw new OtaError(507, "OTA storage file limit reached.");
  }
  function validatePublication(value: unknown): { publication: Publication; manifest: Manifest } {
    const parsed = publicationSchema.safeParse(value);
    if (!parsed.success) throw new OtaError(400, "Invalid publication envelope.");
    const publication = parsed.data;
    const parsedManifest = manifestSchema.safeParse(parseJson(publication.manifest));
    if (!parsedManifest.success) throw new OtaError(400, "Invalid Expo manifest.");
    const manifest = parsedManifest.data;
    if (manifest.metadata.channel !== publication.channel || manifest.metadata.platform !== publication.platform)
      throw new OtaError(400, "Manifest metadata must match publication channel and platform.");
    if (manifest.launchAsset.contentType !== "application/javascript")
      throw new OtaError(400, "The launch asset must be application/javascript.");
    if (manifest.assets.some(asset => !asset.fileExtension))
      throw new OtaError(400, "SDK 58 requires fileExtension for every non-launch asset.");
    const keys = new Set<string>();
    for (const asset of [manifest.launchAsset, ...manifest.assets]) {
      const bytes = Buffer.from(asset.hash, "base64url");
      if (bytes.toString("base64url") !== asset.hash || bytes.length !== 32 ||
        asset.url !== assetUrl(bytes.toString("hex")))
        throw new OtaError(400, "Asset URLs must match the public OTA origin and SHA256 path.");
      if (keys.has(asset.key)) throw new OtaError(400, "Asset keys must be unique.");
      keys.add(asset.key);
    }
    const cert = certificates.get(publication.keyid);
    if (!cert || Date.now() < Date.parse(cert.validFrom) || Date.now() > Date.parse(cert.validTo))
      throw new OtaError(403, "Unknown or expired signing certificate.");
    const signature = Buffer.from(publication.signature, "base64");
    if (signature.toString("base64") !== publication.signature ||
      !verify("RSA-SHA256", Buffer.from(publication.manifest), {
        key: cert.publicKey, padding: constants.RSA_PKCS1_PADDING,
      }, signature))
      throw new OtaError(403, "Invalid manifest signature.");
    return { publication, manifest };
  }
  function decodeAsset(stored: Buffer): { contentType: string; bytes: Buffer } {
    const separator = stored.indexOf(10);
    if (separator < 0 || separator > 256) throw new Error("Corrupt OTA asset header.");
    const header = z.object({ contentType: z.string().regex(mimePattern) }).strict()
      .parse(parseJson(stored.subarray(0, separator).toString("utf8")));
    return { contentType: header.contentType, bytes: stored.subarray(separator + 1) };
  }
  async function readAsset(hash: string) {
    const stored = await optionalFile(join(assetsDir, hash));
    if (!stored) throw new OtaError(404, "OTA asset not found.");
    const asset = decodeAsset(stored);
    if (digest(asset.bytes) !== hash) throw new Error("Corrupt OTA asset bytes.");
    return asset;
  }
  async function upload(request: Request, hash: string) {
    authorize(request);
    if (!hashPattern.test(hash)) throw new OtaError(400, "Invalid asset hash.");
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.length > 128 || !mimePattern.test(contentType))
      throw new OtaError(415, "Send the asset's exact MIME Content-Type without parameters.");
    return locked(async () => {
      const bytes = await boundedBody(request, 64 * MiB);
      if (digest(bytes) !== hash) throw new OtaError(400, "Asset SHA256 mismatch.");
      const existing = await optionalFile(join(assetsDir, hash));
      if (existing) {
        const asset = decodeAsset(existing);
        if (asset.contentType !== contentType || !asset.bytes.equals(bytes))
          throw new OtaError(409, "Immutable asset conflicts with existing content.");
        return json({ hash, url: assetUrl(hash) });
      }
      const stored = Buffer.concat([Buffer.from(`${JSON.stringify({ contentType })}\n`), bytes]);
      await budget(stored.length);
      await atomicFile(join(assetsDir, hash), stored);
      return json({ hash, url: assetUrl(hash) }, 201);
    });
  }
  async function publish(request: Request) {
    authorize(request);
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
      throw new OtaError(415, "Send application/json.");
    const { publication, manifest } = validatePublication(parseJson((await boundedBody(request, MiB)).toString("utf8")));
    if (Date.parse(manifest.createdAt) > Date.now() + 300_000)
      throw new OtaError(400, "Manifest creation time is too far in the future.");
    return locked(async () => {
      const recordPath = join(recordsDir, `${manifest.id}.json`);
      const scopePath = join(scopesDir, `${scopeKey(publication, manifest.runtimeVersion)}.json`);
      const record = Buffer.from(JSON.stringify(publication));
      const existing = await optionalFile(recordPath);
      const previous = await optionalFile(scopePath);
      if (existing) {
        if (!existing.equals(record)) throw new OtaError(409, "Update UUID is already immutable.");
        if (previous?.toString() === manifest.id) return json({ id: manifest.id });
      }
      if (previous) {
        const old = await readFile(join(recordsDir, `${previous.toString()}.json`));
        const oldManifest = validatePublication(parseJson(old.toString())).manifest;
        if (Date.parse(manifest.createdAt) <= Date.parse(oldManifest.createdAt))
          throw new OtaError(409, "Publication must be newer than the active release.");
      }
      for (const asset of [manifest.launchAsset, ...manifest.assets]) {
        const stored = await readAsset(Buffer.from(asset.hash, "base64url").toString("hex"));
        if (stored.contentType !== asset.contentType) throw new OtaError(400, "Uploaded asset MIME does not match manifest.");
      }
      await budget((existing ? 0 : record.length) + manifest.id.length - (previous?.length ?? 0));
      if (!existing) await atomicFile(recordPath, record);
      await atomicFile(scopePath, Buffer.from(manifest.id));
      return json({ id: manifest.id }, 201);
    });
  }
  async function update(request: Request, head: boolean) {
    if (request.headers.get("expo-protocol-version") !== "1")
      throw new OtaError(406, "Only Expo Updates protocol 1 is supported.");
    const scope = scopeSchema.safeParse({
      platform: request.headers.get("expo-platform"),
      channel: request.headers.get("expo-channel-name"),
    });
    const runtime = request.headers.get("expo-runtime-version") ?? "";
    if (!scope.success || !/^[A-Za-z0-9._-]{1,128}$/.test(runtime))
      throw new OtaError(400, "Send a supported platform, channel and runtime version.");
    const accept = (request.headers.get("accept") ?? "*/*").split(",").map(part => {
      const [type, ...parameters] = part.trim().split(";");
      const q = parameters.find(p => p.trim().startsWith("q="));
      return { type: type?.trim() ?? "", q: q ? Number(q.trim().slice(2)) : 1 };
    });
    const supported = ["application/expo+json", "application/json"];
    const negotiated = supported.map(candidate => {
      const exact = accept.find(a => a.type === candidate);
      const q = (exact ?? accept.find(a => a.type === "application/*") ?? accept.find(a => a.type === "*/*"))?.q ?? 0;
      return { type: candidate, q };
    }).filter(a => a.q > 0 && a.q <= 1).sort((a, b) => b.q - a.q)[0];
    if (!negotiated) throw new OtaError(406, "Accept application/expo+json or application/json.");
    const pointer = await optionalFile(join(scopesDir, `${scopeKey(scope.data, runtime)}.json`));
    if (!pointer) throw new OtaError(404, "No published update for this runtime, platform and channel.");
    if (!z.string().uuid().safeParse(pointer.toString()).success) throw new Error("Corrupt OTA scope pointer.");
    const stored = await readFile(join(recordsDir, `${pointer.toString()}.json`));
    const { publication, manifest } = validatePublication(parseJson(stored.toString()));
    if (manifest.runtimeVersion !== runtime || publication.platform !== scope.data.platform ||
      publication.channel !== scope.data.channel) throw new Error("Corrupt OTA release scope.");
    const expectation = request.headers.get("expo-expect-signature");
    if (expectation) {
      const keyid = /(?:^|,)\s*keyid="([A-Za-z0-9_-]+)"\s*(?:,|$)/.exec(expectation)?.[1];
      const alg = /(?:^|,)\s*alg="([^"]+)"\s*(?:,|$)/.exec(expectation)?.[1];
      if ((keyid && keyid !== publication.keyid) || (alg && alg !== "rsa-v1_5-sha256"))
        throw new OtaError(406, "No update signed with the requested key and algorithm.");
    }
    return new Response(head ? null : publication.manifest, { headers: {
      "content-type": negotiated.type,
      "content-length": String(Buffer.byteLength(publication.manifest)),
      "cache-control": "private, max-age=0, no-store",
      "expo-protocol-version": "1",
      "expo-sfv-version": "0",
      "expo-manifest-filters": `channel="${publication.channel}", platform="${publication.platform}"`,
      "expo-server-defined-headers": "",
      "expo-signature": signatureHeader(publication),
      "x-content-type-options": "nosniff",
    } });
  }
  return async (request: Request, action: "update" | "asset" | "upload" | "publish", hash?: string): Promise<Response> => {
    try {
      if (action === "publish" && request.method === "POST") return await publish(request);
      if (action === "upload" && request.method === "PUT") return await upload(request, hash ?? "");
      if (action === "update" && ["GET", "HEAD"].includes(request.method))
        return await update(request, request.method === "HEAD");
      if (action === "asset" && ["GET", "HEAD"].includes(request.method)) {
        if (!hashPattern.test(hash ?? "")) throw new OtaError(400, "Invalid asset hash.");
        const asset = await readAsset(hash!);
        return new Response(request.method === "HEAD" ? null : new Uint8Array(asset.bytes), { headers: {
          "content-type": asset.contentType,
          "content-length": String(asset.bytes.length),
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
        } });
      }
      throw new OtaError(405, "Method not allowed.");
    } catch (error) {
      if (error instanceof OtaError) return json({ error: error.message }, error.status);
      console.error("[ota-updates] Storage or protocol operation failed.", error instanceof Error ? error.message : "Unknown error");
      return json({ error: "OTA storage unavailable; operator inspection required." }, 503);
    }
  };
}

export async function otaRequest(request: Request, action: "update" | "asset" | "upload" | "publish", hash?: string) {
  if (!process.env.OTA_STORAGE_DIR || !process.env.OTA_PUBLISH_TOKEN_SHA256 || !process.env.OTA_SIGNING_CERTIFICATES)
    return json({ error: "Self-hosted OTA updates are not configured." }, 503);
  try {
    const certificates = z.record(z.string(), z.string()).parse(parseJson(process.env.OTA_SIGNING_CERTIFICATES));
    return await createOtaHandler({
      storageDir: process.env.OTA_STORAGE_DIR,
      publicUrl: process.env.PUBLIC_URL ?? "",
      tokenHash: process.env.OTA_PUBLISH_TOKEN_SHA256,
      certificates,
      maxStorageBytes: process.env.OTA_MAX_STORAGE_BYTES ? Number(process.env.OTA_MAX_STORAGE_BYTES) : undefined,
    })(request, action, hash);
  } catch (error) {
    console.error("[ota-updates] Invalid server configuration.", error instanceof Error ? error.message : "Unknown error");
    return json({ error: "OTA configuration invalid; operator inspection required." }, 503);
  }
}
