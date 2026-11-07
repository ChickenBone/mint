import type { CredentialStorage } from "./storage";

export function serializedCredentials(storage: CredentialStorage) {
  let pending: Promise<unknown> = Promise.resolve();
  return <T>(operation: (storage: CredentialStorage) => Promise<T>): Promise<T> => {
    const result = pending.then(() => operation(storage), () => operation(storage));
    pending = result;
    return result;
  };
}
