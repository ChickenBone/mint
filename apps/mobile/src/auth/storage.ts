export interface CredentialStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
const values = new Map<string, string>();
export const credentialStorage: CredentialStorage = {
  async get(key) { return values.get(key) ?? null; },
  async set(key, value) { values.set(key, value); },
  async remove(key) { values.delete(key); },
};
