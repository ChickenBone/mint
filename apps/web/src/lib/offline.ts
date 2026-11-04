import { z } from "zod";
import { playerItemSchema, type PlayerItem } from "./player-protocol";

const DATABASE = "mint-offline-v1";
const grantSchema = z.object({ memberId: z.uuid(), expiresAt: z.number().int().positive(), token: z.string().min(1) });
export type OfflineGrant = z.infer<typeof grantSchema>;
export interface OfflineSong { id: string; memberId: string; item: PlayerItem; blob: Blob; bytes: number; savedAt: number }
export interface OfflineCollection { id: string; memberId: string; title: string; trackIds: string[]; savedAt: number }
export interface OfflineSettings { grant: OfflineGrant; limit: number }
const MAX_LIMIT = 20 * 1024 ** 3;
const DEFAULT_LIMIT = 2 * 1024 ** 3;

function database(): Promise<IDBDatabase> {
  if (!("indexedDB" in globalThis)) return Promise.reject(new Error("Offline storage is unavailable in this browser."));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("songs")) request.result.createObjectStore("songs", { keyPath: "id" });
      if (!request.result.objectStoreNames.contains("settings")) request.result.createObjectStore("settings");
      if (!request.result.objectStoreNames.contains("collections")) request.result.createObjectStore("collections", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Offline storage could not open."));
    request.onblocked = () => reject(new Error("Close other Mint tabs and retry the storage update."));
  });
}

async function transaction<T>(stores: string[], mode: IDBTransactionMode, run: (tx: IDBTransaction, done: (value: T) => void, fail: (error: Error) => void) => void): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let value: T, failure: Error | undefined;
    tx.oncomplete = () => { db.close(); resolve(value); };
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error("Offline storage failed. Check available device space.")); };
    tx.onabort = () => { db.close(); reject(failure ?? tx.error ?? new Error("Offline storage operation was cancelled.")); };
    try { run(tx, (result) => { value = result; }, (error) => { failure = error; tx.abort(); }); } catch (error) { tx.abort(); db.close(); reject(error); }
  });
}

export async function offlineSettings(): Promise<OfflineSettings | null> {
  return transaction(["settings"], "readonly", (tx, done, fail) => {
    const request = tx.objectStore("settings").get("active");
    request.onsuccess = () => {
      if (!request.result) return done(null);
      const settings = request.result as OfflineSettings;
      const grant = grantSchema.safeParse(settings.grant);
      if (!grant.success) return fail(new Error("Your offline access data is damaged. Remove device downloads and reconnect to Mint."));
      done({ grant: grant.data, limit: Number.isSafeInteger(settings.limit) ? settings.limit : DEFAULT_LIMIT });
    };
  });
}

export async function clearOffline() {
  await transaction<void>(["songs", "settings", "collections"], "readwrite", (tx, done) => {
    tx.objectStore("songs").clear(); tx.objectStore("settings").clear(); tx.objectStore("collections").clear(); done();
  });
  for (const key of Object.keys(localStorage)) if (key.startsWith("mint:player:") || key.startsWith("mint:offline:")) localStorage.removeItem(key);
  window.dispatchEvent(new Event("mint-offline-changed"));
}

export async function authorizeOffline(memberId: string, signal?: AbortSignal): Promise<OfflineSettings> {
  const response = await fetch("/api/player/offline", { cache: "no-store", credentials: "same-origin", signal });
  if (response.status === 401) {
    await clearOffline();
    throw new Error("Offline access has expired. Sign in again.");
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Offline access could not be verified.");
  const grant = grantSchema.parse(body);
  if (grant.memberId !== memberId) { await clearOffline(); throw new Error("The signed-in account changed. Reload Mint."); }
  const previous = await offlineSettings();
  if (previous && previous.grant.memberId !== memberId) await clearOffline();
  const settings = { grant, limit: previous?.grant.memberId === memberId ? previous.limit : DEFAULT_LIMIT };
  await transaction<void>(["settings"], "readwrite", (tx, done) => { tx.objectStore("settings").put(settings, "active"); done(); });
  return settings;
}

export async function listOffline(memberId: string): Promise<OfflineSong[]> {
  const settings = await offlineSettings();
  if (!settings || settings.grant.memberId !== memberId) return [];
  return transaction(["songs"], "readonly", (tx, done) => {
    const request = tx.objectStore("songs").getAll();
    request.onsuccess = () => done((request.result as OfflineSong[]).filter((song) => song.memberId === memberId));
  });
}

export async function saveOfflineCollection(memberId: string, collection: { id: string; title: string; trackIds: string[] }) {
  const songs = await listOffline(memberId), available = new Set(songs.map((song) => song.id));
  const trackIds = collection.trackIds.filter((id) => available.has(id));
  if (!trackIds.length) return;
  await transaction<void>(["collections", "settings"], "readwrite", (tx, done, fail) => {
    const request = tx.objectStore("settings").get("active");
    request.onsuccess = () => {
      if ((request.result as OfflineSettings | undefined)?.grant.memberId !== memberId) return fail(new Error("The offline account changed before the collection could save."));
      tx.objectStore("collections").put({ ...collection, memberId, trackIds, savedAt: Date.now() } satisfies OfflineCollection); done();
    };
  });
}

export async function setOfflineLimit(memberId: string, limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 50 * 1024 ** 2 || limit > MAX_LIMIT) throw new Error("Choose a storage limit between 50 MB and 20 GB.");
  const settings = await offlineSettings();
  if (!settings || settings.grant.memberId !== memberId) throw new Error("Connect to Mint to enable downloads first.");
  const songs = await listOffline(memberId);
  if (songs.reduce((sum, song) => sum + song.bytes, 0) > limit) throw new Error("Remove downloads before reducing the storage limit below their current size.");
  await transaction<void>(["settings"], "readwrite", (tx, done) => { tx.objectStore("settings").put({ ...settings, limit }, "active"); done(); });
}

export async function removeOffline(memberId: string, id: string) {
  const settings = await offlineSettings();
  if (settings?.grant.memberId !== memberId) throw new Error("This download belongs to a different account.");
  await transaction<void>(["songs"], "readwrite", (tx, done) => { tx.objectStore("songs").delete(id); done(); });
  window.dispatchEvent(new Event("mint-offline-changed"));
}

export async function downloadSong(memberId: string, input: PlayerItem, signal: AbortSignal, progress: (bytes: number, total: number | null) => void, format: "original" | "mp3" = "original") {
  const item = playerItemSchema.parse(input);
  if (item.type !== "track" || !z.uuid().safeParse(item.id).success) throw new Error("Select a downloaded song to save offline.");
  const settings = await authorizeOffline(memberId, signal);
  const existing = await listOffline(memberId), used = existing.reduce((sum, song) => sum + (song.id === item.id ? 0 : song.bytes), 0);
  const response = await fetch(`/api/player/audio/${item.id}${format === "mp3" ? "?format=mp3" : ""}`, { signal, cache: "no-store", credentials: "same-origin" });
  if (!response.ok || !response.body) throw new Error(response.status === 401 ? "Your listening access expired. Sign in again." : "This song could not download. Check the server and try again.");
  const type = response.headers.get("content-type") ?? "";
  if (!type.startsWith("audio/")) throw new Error("The server did not return an audio file.");
  const declared = Number(response.headers.get("content-length")) || null;
  const estimate = await navigator.storage?.estimate();
  const physical = estimate?.quota !== undefined && estimate.usage !== undefined ? Math.max(0, estimate.quota - estimate.usage - 10 * 1024 ** 2) : Infinity;
  const available = Math.min(settings.limit - used, physical, 512 * 1024 ** 2);
  if (declared !== null && declared > available) { await response.body.cancel(); throw new Error("This download exceeds your storage limit. Remove music or raise the limit."); }
  const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > available) throw new Error("This download exceeds your storage limit.");
      chunks.push(new Uint8Array(value)); progress(bytes, declared);
    }
  } catch (error) { await reader.cancel(); throw error; }
  if (!bytes || declared !== null && bytes !== declared) throw new Error("The download was interrupted. Retry to save a complete file.");
  const song: OfflineSong = { id: item.id, memberId, item, blob: new Blob(chunks, { type }), bytes, savedAt: Date.now() };
  await transaction<void>(["songs", "settings"], "readwrite", (tx, done, fail) => {
    const active = tx.objectStore("settings").get("active");
    active.onsuccess = () => {
      const settings = active.result as OfflineSettings | undefined;
      if (settings?.grant.memberId !== memberId || settings.grant.expiresAt <= Date.now()) return fail(new Error("The signed-in account or offline access changed. Reconnect before saving this song."));
      const saved = tx.objectStore("songs").getAll();
      saved.onsuccess = () => {
        const used = (saved.result as OfflineSong[]).reduce((sum, song) => sum + (song.id === item.id ? 0 : song.bytes), 0);
        if (used + bytes > settings.limit) return fail(new Error("Another download used the remaining storage. Remove songs or raise the storage limit."));
        tx.objectStore("songs").put(song); done();
      };
    };
  });
  window.dispatchEvent(new Event("mint-offline-changed"));
}

export async function offlineAudio(memberId: string, id: string): Promise<string | null> {
  const settings = await offlineSettings();
  if (!settings || settings.grant.memberId !== memberId || settings.grant.expiresAt <= Date.now()) return null;
  const song = await transaction<OfflineSong | undefined>(["songs"], "readonly", (tx, done) => {
    const request = tx.objectStore("songs").get(id);
    request.onsuccess = () => done(request.result as OfflineSong | undefined);
  });
  return song?.memberId === memberId ? URL.createObjectURL(song.blob) : null;
}
