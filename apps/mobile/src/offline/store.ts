import type { MobileTrack } from "../playback/types";
import type { MediaSource, QueueStorage } from "../playback/engine";

export const OFFLINE_BUDGET = 1024 * 1024 * 1024;
export const MAX_TRACK_BYTES = 128 * 1024 * 1024;
export interface OfflineEntry extends MobileTrack {
  status: "queued" | "downloading" | "ready" | "failed";
  bytes: number;
  expectedBytes: number;
  error: string | null;
}
export interface OfflineState {
  entries: OfflineEntry[];
  status: "loading" | "ready" | "unavailable";
  bytes: number;
  budgetBytes: number;
  error: string | null;
}
export interface OfflineFiles {
  probe(source: MediaSource, signal: AbortSignal): Promise<number>;
  download(id: string, source: MediaSource, expected: number, signal: AbortSignal, progress: (bytes: number) => void): Promise<void>;
  exists(id: string, bytes: number): Promise<boolean>;
  uri(id: string): string;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
}
export interface OfflineApi {
  entitlement(signal: AbortSignal): Promise<{ memberId: string; expiresAt: number }>;
  source(id: string): MediaSource;
}

export class OfflineStore {
  state: OfflineState = { entries: [], status: "loading", bytes: 0, budgetBytes: OFFLINE_BUDGET, error: null };
  private expiresAt = 0;
  private jobs = new Map<string, AbortController>();
  private listeners = new Set<() => void>();
  private disposed = false;
  private saving: Promise<void> = Promise.resolve();
  private request = new AbortController();
  private pending = new Map<string, Promise<void>>();
  private clearing = false;

  constructor(private files: OfflineFiles, private api: OfflineApi, private storage: QueueStorage, private key: string, private accountId: string) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.state;
  private publish(entries = this.state.entries, error = this.state.error) {
    if (this.disposed || this.clearing) return;
    this.state = { ...this.state, entries: [...entries], bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), error };
    for (const listener of this.listeners) listener();
  }
  private persist() {
    if (this.disposed || this.clearing) return;
    const value = JSON.stringify({ version: 1, expiresAt: this.expiresAt, entries: this.state.entries });
    this.saving = this.saving.then(() => this.storage.setItem(this.key, value)).catch((error: unknown) => {
      this.publish(undefined, `Downloads could not be saved: ${message(error)}`);
    });
  }
  async restore() {
    const raw = await this.storage.getItem(this.key);
    if (this.disposed) return;
    if (raw) {
      const value: unknown = JSON.parse(raw);
      if (!validManifest(value)) throw new Error("The download manifest is invalid. Remove downloads and try again.");
      this.expiresAt = value.expiresAt;
      const entries: OfflineEntry[] = [];
      for (const entry of value.entries) {
        if (entry.status === "ready" && await this.files.exists(entry.id, entry.bytes)) entries.push(entry);
        else {
          await this.files.remove(entry.id);
          entries.push({ ...entry, status: "failed", bytes: 0, error: "Download was interrupted. Retry to download it again." });
        }
      }
      this.state = { ...this.state, entries };
    }
    this.state = { ...this.state, status: "ready" };
    this.publish();
    this.persist();
  }
  async renew() {
    const entitlement = await this.api.entitlement(this.request.signal);
    if (entitlement.memberId !== this.accountId || !Number.isFinite(entitlement.expiresAt) ||
        entitlement.expiresAt <= Date.now() || entitlement.expiresAt > Date.now() + 8 * 86400_000) {
      throw new Error("Offline listening permission is invalid. Sign in again.");
    }
    if (this.disposed) return;
    this.expiresAt = entitlement.expiresAt;
    this.persist();
  }
  async restoreWithRenewal(isConnectionFailure: (error: unknown) => boolean) {
    await this.restore();
    try { await this.renew(); }
    catch (error) {
      if (!isConnectionFailure(error)) throw error;
      this.publish(undefined, "Offline permission could not renew. Existing downloads are available only while their saved permission is valid.");
    }
  }
  async source(id: string): Promise<MediaSource | null> {
    if (this.disposed) return null;
    const entry = this.state.entries.find((item) => item.id === id && item.status === "ready");
    if (!entry) return null;
    if (this.expiresAt <= Date.now()) throw new Error("Offline permission expired. Connect to Mint to renew it.");
    if (!await this.files.exists(id, entry.bytes)) {
      this.publish(this.state.entries.map((item) => item.id === id ? { ...item, status: "failed", bytes: 0, error: "File is missing. Retry this download." } : item));
      this.persist();
      throw new Error("This download is missing. Download the song again.");
    }
    return { uri: this.files.uri(id), name: entry.title };
  }
  async download(track: MobileTrack) {
    if (this.disposed || this.clearing) throw new Error("Download storage is closing. Try again in a moment.");
    if (this.state.status !== "ready") throw new Error("Download storage needs attention. Remove saved downloads in Settings and try again.");
    if (this.state.entries.some((entry) => entry.id === track.id && entry.status !== "failed")) return;
    await this.renew();
    if (this.disposed) return;
    if (this.state.entries.length >= 5000) throw new Error("Remove a download before adding more than 5,000 songs.");
    this.publish([...this.state.entries.filter((entry) => entry.id !== track.id),
      { ...track, status: "queued", bytes: 0, expectedBytes: 0, error: null }], null);
    this.persist();
    this.pump();
  }
  async retry(id: string) {
    const entry = this.state.entries.find((item) => item.id === id);
    if (!entry) throw new Error("This download no longer exists.");
    await this.remove(id);
    await this.download(entry);
  }
  private pump() {
    if (this.disposed || this.clearing) return;
    for (const entry of this.state.entries) {
      if (this.jobs.size >= 2) break;
      if (entry.status !== "queued" || this.jobs.has(entry.id)) continue;
      const controller = new AbortController();
      this.jobs.set(entry.id, controller);
      const task = this.run(entry, controller);
      this.pending.set(entry.id, task);
      void task.finally(() => { if (this.pending.get(entry.id) === task) this.pending.delete(entry.id); });
    }
  }
  private async run(entry: OfflineEntry, controller: AbortController) {
    let reserved = 0;
    try {
      const source = this.api.source(entry.id);
      reserved = await this.files.probe(source, controller.signal);
      if (!Number.isInteger(reserved) || reserved <= 0 || reserved > MAX_TRACK_BYTES) throw new Error("This song exceeds the 128 MB per-download limit.");
      const committed = this.state.entries.filter((item) => item.id !== entry.id)
        .reduce((sum, item) => sum + Math.max(item.bytes, item.expectedBytes), 0);
      if (committed + reserved > this.state.budgetBytes) throw new Error("Download storage is full. Remove songs and retry.");
      if (controller.signal.aborted || this.disposed) return;
      this.publish(this.state.entries.map((item) => item.id === entry.id ? { ...item, status: "downloading", expectedBytes: reserved } : item));
      await this.files.download(entry.id, source, reserved, controller.signal, (bytes) => {
        if (controller.signal.aborted || this.disposed) return;
        this.publish(this.state.entries.map((item) => item.id === entry.id ? { ...item, bytes } : item));
      });
      if (controller.signal.aborted || this.disposed) {
        await this.files.remove(entry.id);
        return;
      }
      if (!await this.files.exists(entry.id, reserved)) throw new Error("Downloaded file is incomplete. Retry this song.");
      if (this.expiresAt <= Date.now()) throw new Error("Offline permission expired during download. Connect and retry.");
      this.publish(this.state.entries.map((item) => item.id === entry.id ? { ...item, status: "ready", bytes: reserved, expectedBytes: reserved } : item));
    } catch (error) {
      await this.files.remove(entry.id).catch((cleanup: unknown) => this.publish(undefined, `Download cleanup failed: ${message(cleanup)}`));
      if (!controller.signal.aborted && !this.disposed) {
        this.publish(this.state.entries.map((item) => item.id === entry.id
          ? { ...item, status: "failed", bytes: 0, expectedBytes: 0, error: message(error) } : item), message(error));
      }
    } finally {
      this.jobs.delete(entry.id);
      this.persist();
      this.pump();
    }
  }
  async remove(id: string) {
    const controller = this.jobs.get(id);
    controller?.abort();
    await this.pending.get(id);
    await this.files.remove(id);
    this.publish(this.state.entries.filter((entry) => entry.id !== id), null);
    this.persist();
  }
  async clear() {
    this.clearing = true;
    for (const job of this.jobs.values()) job.abort();
    try {
      await Promise.all(this.pending.values());
      await this.files.clear();
      this.expiresAt = 0;
      this.state = { ...this.state, entries: [], status: "ready", error: null };
    } finally { this.clearing = false; this.publish(); this.persist(); }
  }
  async revoke() {
    this.disposed = true;
    this.request.abort();
    for (const job of this.jobs.values()) job.abort();
    await Promise.all(this.pending.values());
    await this.saving;
    await this.files.clear();
    await this.storage.removeItem(this.key);
    this.listeners.clear();
  }
  error(error: unknown, unavailable = false) {
    if (unavailable) this.state = { ...this.state, status: "unavailable" };
    this.publish(undefined, message(error));
  }
}

function message(error: unknown) { return error instanceof Error ? error.message : "Download failed. Check your connection and retry."; }
function validManifest(value: unknown): value is { version: 1; expiresAt: number; entries: OfflineEntry[] } {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 ||
      !("expiresAt" in value) || typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt) ||
      !("entries" in value) || !Array.isArray(value.entries) || value.entries.length > 5000) return false;
  return value.entries.every((entry: unknown) => entry && typeof entry === "object" && "id" in entry && typeof entry.id === "string" &&
    "title" in entry && typeof entry.title === "string" && "bytes" in entry && typeof entry.bytes === "number" &&
    Number.isInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= MAX_TRACK_BYTES && "expectedBytes" in entry &&
    typeof entry.expectedBytes === "number" && Number.isInteger(entry.expectedBytes) && entry.expectedBytes >= 0 && entry.expectedBytes <= MAX_TRACK_BYTES &&
    "status" in entry && ["queued", "downloading", "ready", "failed"].includes(String(entry.status))) &&
    new Set(value.entries.map((entry: OfflineEntry) => entry.id)).size === value.entries.length;
}
