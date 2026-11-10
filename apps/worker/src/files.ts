import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { http } from "./http";

export async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function exists(p: string) {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

/** Streams a URL to disk via a .part file, then renames atomically. Reports progress 0..1 (or null when size unknown). */
export async function downloadToFile(
  url: string,
  dest: string,
  onProgress?: (fraction: number | null, bytes: number) => void | Promise<void>,
  headers: Record<string, string> = {},
): Promise<{ bytes: number; contentType: string | null; filename: string | null }> {
  await ensureDir(path.dirname(dest));
  const res = await http(url, { timeoutMs: 60 * 60 * 1000, retries: 1, headers: { accept: "*/*", ...headers } });
  if (!res.body) throw new Error("Empty response body");
  const total = Number(res.headers.get("content-length")) || 0;
  let bytes = 0;
  let lastEmit = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      const now = Date.now();
      if (onProgress && now - lastEmit > 750) {
        lastEmit = now;
        Promise.resolve().then(() => onProgress(total ? bytes / total : null, bytes)).then(
          () => cb(null, chunk),
          (err: Error) => cb(err),
        );
        return;
      }
      cb(null, chunk);
    },
  });
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body as never), meter, createWriteStream(tmp));
  if (bytes === 0) {
    await fs.rm(tmp, { force: true });
    throw new Error("Download was empty");
  }
  await fs.rename(tmp, dest);
  await onProgress?.(1, bytes);
  const disposition = res.headers.get("content-disposition");
  const filename = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1] ?? null;
  return { bytes, contentType: res.headers.get("content-type"), filename: filename ? decodeURIComponent(filename) : null };
}

export async function moveFile(src: string, dest: string) {
  await ensureDir(path.dirname(dest));
  try {
    await fs.rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await fs.copyFile(src, dest);
    await fs.unlink(src);
  }
}
