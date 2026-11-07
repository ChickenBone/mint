import AsyncStorage from "@react-native-async-storage/async-storage";
import { digestStringAsync, CryptoDigestAlgorithm } from "expo-crypto";
import { createOfflineFiles } from "../offline/files";

const active = new Map<string, () => Promise<void>>();
export async function accountScope(serverUrl: string, userId: string): Promise<string> {
  return digestStringAsync(CryptoDigestAlgorithm.SHA256, JSON.stringify([serverUrl, userId]));
}
export function registerPlaybackCleanup(scope: string, cleanup: () => Promise<void>) {
  active.set(scope, cleanup);
  return () => { if (active.get(scope) === cleanup) active.delete(scope); };
}
export async function revokePlaybackAccount(serverUrl: string, userId: string): Promise<void> {
  const scope = await accountScope(serverUrl, userId);
  await active.get(scope)?.();
  active.delete(scope);
  await createOfflineFiles(scope).clear();
  await AsyncStorage.multiRemove([`mint.queue.v1.${scope}`, `mint.offline.v1.${scope}`, `mint.diagnostics.v1.${scope}`]);
}
