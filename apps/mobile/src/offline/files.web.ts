import type { OfflineFiles } from "./store";

export function createOfflineFiles(): OfflineFiles {
  const unsupported = async (): Promise<never> => { throw new Error("Downloads are available in the Android and iOS app. Web listening requires a connection."); };
  return { probe: unsupported, download: unsupported, exists: async () => false, uri: () => "",
    remove: async () => {}, clear: async () => {} };
}
