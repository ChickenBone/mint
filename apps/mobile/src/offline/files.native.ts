import { Directory, File, Paths } from "expo-file-system";
import { fetch } from "expo/fetch";
import type { OfflineFiles } from "./store";
import type { MediaSource } from "../playback/engine";

export function createOfflineFiles(scopeHash: string): OfflineFiles {
  if (!/^[a-f0-9]{64}$/.test(scopeHash)) throw new Error("Invalid offline storage scope.");
  const root = new Directory(Paths.document, "mint-offline", scopeHash);
  const safe = (id: string) => {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid download track.");
    return id;
  };
  const file = (id: string) => new File(root, `${safe(id)}.audio`);
  const partial = (id: string) => new File(root, `${safe(id)}.partial`);
  return {
    async probe(source: MediaSource, signal: AbortSignal) {
      const response = await fetch(source.uri, { headers: { ...source.headers, Range: "bytes=0-0" }, signal });
      try {
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "Listening permission expired. Sign in again." : "The server could not download this song.");
        if (!/^audio\//i.test(response.headers.get("content-type") ?? "")) throw new Error("The server did not return an audio file.");
        const range = response.headers.get("content-range");
        const total = range ? Number(/\/(\d+)$/.exec(range)?.[1]) : Number(response.headers.get("content-length"));
        if (!total || !Number.isFinite(total)) throw new Error("The server did not provide the download size.");
        return total;
      } finally { await response.body?.cancel(); }
    },
    async download(id, source, expected, signal, progress) {
      root.create({ idempotent: true, intermediates: true });
      const target = partial(id);
      if (target.exists) await target.delete();
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) controller.abort();
      try {
        const downloaded = await File.downloadFileAsync(source.uri, target, {
          headers: source.headers, signal: controller.signal,
          onProgress({ bytesWritten, totalBytes }) {
            if (bytesWritten > expected || totalBytes > expected) controller.abort();
            progress(Math.min(bytesWritten, expected));
          },
        });
        if (signal.aborted || downloaded.size !== expected) throw new Error("The download is incomplete. Retry it.");
        await downloaded.move(file(id));
      } finally {
        signal.removeEventListener("abort", abort);
        if (target.exists) await target.delete();
      }
    },
    async exists(id, bytes) { const target = file(id); return target.exists && target.size === bytes && bytes > 0; },
    uri(id) { return file(id).uri; },
    async remove(id) {
      for (const target of [file(id), partial(id)]) if (target.exists) await target.delete();
    },
    async clear() { if (root.exists) await root.delete(); },
  };
}
