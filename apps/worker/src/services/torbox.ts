import { requireEnv } from "@mint/core/env";
import { httpJson } from "../http";

const API = "https://api.torbox.app/v1/api";

export function torboxEnabled() {
  return Boolean(process.env.TORBOX_API_KEY);
}

interface Envelope<T> {
  success: boolean;
  error: string | null;
  detail: string;
  data: T;
}

export interface TorboxTorrent {
  id: number;
  hash: string;
  name: string;
  size: number;
  progress: number;
  download_state: string;
  download_speed: number;
  eta: number;
  download_finished: boolean;
  download_present: boolean;
  files?: Array<{ id: number; name: string; short_name: string; size: number }>;
}

function auth() {
  return { authorization: `Bearer ${requireEnv("TORBOX_API_KEY")}` };
}

async function call<T>(path: string, init: Parameters<typeof httpJson>[1] = {}): Promise<T> {
  const env = await httpJson<Envelope<T>>(`${API}${path}`, { ...init, headers: { ...auth(), ...init.headers } });
  if (!env.success) throw new Error(`TorBox: ${env.error ?? env.detail}`);
  return env.data;
}

export async function addTorrent(input: { magnet?: string; file?: { name: string; data: Buffer } }, name: string) {
  const form = new FormData();
  if (input.magnet) form.set("magnet", input.magnet);
  if (input.file) form.set("file", new Blob([new Uint8Array(input.file.data)]), input.file.name);
  form.set("name", name);
  form.set("seed", "3");
  form.set("allow_zip", "false");
  return call<{ torrent_id: number; hash: string }>("/torrents/createtorrent", { method: "POST", body: form, timeoutMs: 60_000 });
}

export async function getTorrent(id: number): Promise<TorboxTorrent | null> {
  return call<TorboxTorrent | null>("/torrents/mylist", { query: { id, bypass_cache: true } });
}

export async function fileLink(torrentId: number, fileId: number): Promise<string> {
  return call<string>("/torrents/requestdl", {
    query: { token: requireEnv("TORBOX_API_KEY"), torrent_id: torrentId, file_id: fileId, redirect: false },
  });
}

export async function removeTorrent(id: number) {
  await call("/torrents/controltorrent", { method: "POST", body: { torrent_id: id, operation: "delete" } }).catch(() => undefined);
}
