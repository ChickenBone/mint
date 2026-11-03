import "server-only";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const previewDir = () => process.env.PREVIEW_DIR ?? "/data/previews";
export const isUuid = (s: string) => UUID.test(s);

/** Streams a file from the read-only preview volume with HTTP Range support (needed for audio seeking on Safari). */
export async function serveFile(req: Request, relPath: string, contentType: string): Promise<Response> {
  const root = path.resolve(/*turbopackIgnore: true*/ previewDir());
  const file = path.resolve(/*turbopackIgnore: true*/ root, relPath);
  if (!file.startsWith(root + path.sep)) return new Response("Not found", { status: 404 });
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return new Response("Not found", { status: 404 });

  const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const base: Record<string, string> = {
    "content-type": contentType,
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
    etag,
    "last-modified": info.mtime.toUTCString(),
  };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: base });

  const range = req.headers.get("range");
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : info.size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : info.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, info.size - 1);
    if (start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${info.size}` } });
    const stream = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: { ...base, "content-range": `bytes ${start}-${end}/${info.size}`, "content-length": String(end - start + 1) },
    });
  }
  const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;
  return new Response(stream, { headers: { ...base, "content-length": String(info.size) } });
}
