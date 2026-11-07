import { MintApi } from "@mint/client";

export const createApi = (serverUrl: string, token: string, onUnauthorized?: () => Promise<void>) =>
  new MintApi({ serverUrl, token, onUnauthorized, allowDevelopmentHttp: __DEV__ });
