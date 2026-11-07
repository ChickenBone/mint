import {
  ApiError, nativeCredentialSchema, nativeSessionSchema, normalizeServerUrl,
  type Account, type MintApi, type NativeCredential,
} from "@mint/client";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { z } from "zod";
import { createApi } from "../api/create-api";
import { accountRequest } from "./account-request";
import { credentialStorage } from "./storage";
import { serializedCredentials } from "./persistence";
import { revokePlaybackAccount } from "../playback/account-cleanup";

const CREDENTIAL_KEY = "mint.native.credential.v1";
const DEVICE_KEY = "mint.native.installation.v1";
const credentials = serializedCredentials(credentialStorage);
const savedSchema = z.object({ serverUrl: z.string(), credential: nativeCredentialSchema });
type Saved = z.infer<typeof savedSchema>;
type SignInInput = { serverUrl: string; email: string; password: string };
export type AuthState = {
  status: "loading" | "signed-out" | "signed-in";
  user: Account | null; serverUrl: string | null; error: string | null; api: MintApi | null;
  signIn(input: SignInInput): Promise<void>; signOut(): Promise<void>; refresh(): Promise<void>;
};
const AuthContext = createContext<AuthState | null>(null);
const message = (error: unknown) => error instanceof Error ? error.message : "Your account connection failed.";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [saved, setSaved] = useState<Saved | null>(null);
  const [status, setStatus] = useState<AuthState["status"]>("loading");
  const [error, setError] = useState<string | null>(null);
  const current = useRef<Saved | null>(null);
  const generation = useRef(0);
  const signingIn = useRef(false);
  const update = useCallback((next: Saved | null) => {
    current.current = next;
    setSaved(next);
    setStatus(next ? "signed-in" : "signed-out");
  }, []);
  const clear = useCallback(async (expected?: string, scope = current.current) => {
    if (expected && current.current?.credential.token !== expected) return;
    generation.current++;
    update(null);
    const results = await credentials((storage) => Promise.allSettled([
      storage.remove(CREDENTIAL_KEY),
      scope ? revokePlaybackAccount(scope.serverUrl, scope.credential.user.id) : Promise.resolve(),
    ]));
    const failures = results.filter((result) => result.status === "rejected").map((result) => message(result.reason));
    if (failures.length) {
      const detail = `Account cleanup could not finish: ${failures.join("; ")}`;
      setError(detail);
      throw new Error(detail);
    }
  }, [update]);
  const refresh = useCallback(async () => {
    const snapshot = current.current;
    if (!snapshot) return;
    try {
      const session = await accountRequest(snapshot.serverUrl, "session", nativeSessionSchema, snapshot.credential.token);
      if (current.current?.credential.token !== snapshot.credential.token) return;
      const next = { ...snapshot, credential: { ...snapshot.credential, ...session } };
      await credentials(async (storage) => {
        if (current.current?.credential.token === snapshot.credential.token) await storage.set(CREDENTIAL_KEY, JSON.stringify(next));
      });
      if (current.current?.credential.token !== snapshot.credential.token) return;
      update(next);
      setError(null);
    } catch (failure) {
      if (current.current?.credential.token !== snapshot.credential.token) return;
      if (failure instanceof ApiError && failure.status === 401) await clear(snapshot.credential.token);
      setError(message(failure));
      throw failure;
    }
  }, [clear, update]);

  useEffect(() => {
    let cancelled = false;
    const version = generation.current;
    void (async () => {
      try {
        const raw = await credentials((storage) => storage.get(CREDENTIAL_KEY));
        if (cancelled || version !== generation.current) return;
        if (!raw) { update(null); return; }
        const next = savedSchema.parse(JSON.parse(raw));
        next.serverUrl = normalizeServerUrl(next.serverUrl, __DEV__);
        if (Date.parse(next.credential.expiresAt) <= Date.now()) {
          await clear(undefined, next);
          setError("Your account session expired. Sign in again.");
          return;
        }
        if (cancelled || version !== generation.current) return;
        update(next);
        await refresh();
      } catch (failure) {
        if (cancelled) return;
        setError(message(failure));
        if (!current.current) setStatus("signed-out");
      }
    })();
    return () => { cancelled = true; };
  }, [clear, refresh, update]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && current.current) void refresh().catch((failure: unknown) => setError(message(failure)));
    });
    return () => subscription.remove();
  }, [refresh]);

  const signIn = useCallback(async (input: SignInInput) => {
    if (signingIn.current) throw new Error("A sign-in request is already in progress.");
    signingIn.current = true;
    const version = ++generation.current;
    setError(null);
    try {
      const serverUrl = normalizeServerUrl(input.serverUrl, __DEV__);
      const existingId = await credentials((storage) => storage.get(DEVICE_KEY));
      const deviceId = existingId ? z.uuid().parse(existingId) : Crypto.randomUUID();
      if (!existingId) await credentials((storage) => storage.set(DEVICE_KEY, deviceId));
      const credential: NativeCredential = await accountRequest(serverUrl, "login", nativeCredentialSchema, undefined, {
        email: input.email.trim(), password: input.password, deviceId,
        deviceName: Device.modelName ?? "Mobile listener",
      });
      const next = { serverUrl, credential };
      if (version !== generation.current) {
        await accountRequest(serverUrl, "logout", z.object({ ok: z.literal(true) }), credential.token);
        return;
      }
      try {
        await credentials(async (storage) => {
          if (version === generation.current) await storage.set(CREDENTIAL_KEY, JSON.stringify(next));
        });
      }
      catch (failure) {
        await accountRequest(serverUrl, "logout", z.object({ ok: z.literal(true) }), credential.token);
        throw new Error(`Your secure account credential could not be saved: ${message(failure)}`);
      }
      if (version !== generation.current) {
        await accountRequest(serverUrl, "logout", z.object({ ok: z.literal(true) }), credential.token);
        return;
      }
      update(next);
    } catch (failure) {
      setError(message(failure));
      throw failure;
    } finally {
      signingIn.current = false;
    }
  }, [update]);
  const signOut = useCallback(async () => {
    const snapshot = current.current;
    const outcomes = await Promise.allSettled([
      clear(),
      snapshot ? accountRequest(snapshot.serverUrl, "logout", z.object({ ok: z.literal(true) }), snapshot.credential.token) : Promise.resolve(),
    ]);
    const failures = outcomes.filter((result) => result.status === "rejected").map((result) => message(result.reason));
    if (failures.length) {
      const detail = `Signed out on this device, but account cleanup or server revocation failed: ${failures.join("; ")}`;
      setError(detail);
      throw new Error(detail);
    }
  }, [clear]);
  const serverUrl = saved?.serverUrl, token = saved?.credential.token;
  const api = useMemo(() => serverUrl && token ? createApi(serverUrl, token) : null, [serverUrl, token]);
  useEffect(() => {
    if (!api || !token) return;
    api.setUnauthorizedHandler(async () => {
      await clear(token);
      setError("Your account session was revoked or expired. Sign in again.");
    });
    return () => api.setUnauthorizedHandler(undefined);
  }, [api, token, clear]);
  const value = useMemo<AuthState>(() => ({
    status, user: saved?.credential.user ?? null, serverUrl: saved?.serverUrl ?? null, error, api, signIn, signOut, refresh,
  }), [status, saved, error, api, signIn, signOut, refresh]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider.");
  return value;
}
