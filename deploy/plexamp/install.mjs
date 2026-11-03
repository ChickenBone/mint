import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "4.13.2";
export const SHA256 = "86e5ede3d852a87099a106f2cc6b83e4ec1350000176d83fbcedb83950c48041";
const output = fileURLToPath(new URL("../../apps/web/plexamp-assets/", import.meta.url));

export function adaptBundle(source) {
  const anchor = "r.n=e=>";
  if (source.split(anchor).length !== 2) throw new Error("Plexamp bootstrap changed; adapter requires review");
  return source.replace(anchor, "window.mintPlexamp.install(r,e);r.n=e=>");
}

export async function prepare() {
  await mkdir(output, { recursive: true });
  const dir = await mkdtemp(path.join(tmpdir(), "mint-plexamp-"));
  try {
    const response = await fetch(`https://plexamp.plex.tv/headless/Plexamp-Linux-headless-v${VERSION}.tar.bz2`, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Plexamp download failed (${response.status})`);
    const archive = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(archive).digest("hex") !== SHA256) throw new Error("Plexamp archive checksum mismatch");
    await writeFile(path.join(dir, "app.tar.bz2"), archive);
    execFileSync("tar", ["--extract", "--bzip2", "--no-same-owner", "--no-same-permissions", "--file", path.join(dir, "app.tar.bz2"),
      "--directory", dir, "plexamp/js/index-browser.js"]);
    const source = await readFile(path.join(dir, "plexamp/js/index-browser.js"), "utf8");
    await writeFile(path.join(output, "index.js.tmp"), adaptBundle(source));
    await rename(path.join(output, "index.js.tmp"), path.join(output, "index.js"));
    await writeFile(path.join(output, "version.json"), JSON.stringify({ version: VERSION, archiveSha256: SHA256 }));
    console.log(`Prepared verified Plexamp ${VERSION} browser assets`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepare();
