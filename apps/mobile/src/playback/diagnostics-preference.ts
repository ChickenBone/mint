interface PreferenceStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}
export const diagnosticsPreferenceKey = (scope: string) => `mint.diagnostics.v1.${scope}`;
export class DiagnosticsPreference {
  private generation = 0;
  private disposed = false;
  private writes: Promise<void> = Promise.resolve();
  constructor(private storage: PreferenceStorage, private scope: string, private changed: (value: boolean, warning?: string) => void) {}
  async restore() {
    const generation = this.generation;
    try {
      const value = await this.storage.getItem(diagnosticsPreferenceKey(this.scope));
      if (!this.disposed && generation === this.generation) this.changed(value === "true");
    } catch {
      if (!this.disposed && generation === this.generation) {
        this.changed(false, "The saved diagnostics preference could not be loaded. Diagnostics remain off. Try the toggle again to save your choice.");
      }
    }
  }
  async set(enabled: boolean) {
    if (this.disposed) throw new Error("Sign in to change diagnostics.");
    const generation = ++this.generation;
    // Turning off clears collection immediately, even if device storage fails.
    if (!enabled) this.changed(false);
    const write = this.writes.then(() => this.storage.setItem(diagnosticsPreferenceKey(this.scope), String(enabled)));
    this.writes = write.catch(() => {});
    await write;
    if (!this.disposed && generation === this.generation) this.changed(enabled);
  }
  dispose() { this.disposed = true; this.generation++; return this.writes; }
}
