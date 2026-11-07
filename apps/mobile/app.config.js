module.exports = ({ config }) => {
  const value = process.env.MINT_ANDROID_VERSION_CODE;
  if (value && (!/^[1-9]\d*$/.test(value) || Number(value) > 2100000000)) {
    throw new Error("MINT_ANDROID_VERSION_CODE must be an integer between 1 and 2100000000.");
  }
  const versioned = value ? { ...config, android: { ...config.android, versionCode: Number(value) } } : config;
  const url = process.env.MINT_OTA_URL;
  if (!url) {
    if (process.env.MINT_OTA_CERTIFICATE_PATH || process.env.MINT_NATIVE_RUNTIME) {
      throw new Error("MINT_OTA_URL is required when OTA certificate/runtime settings are supplied.");
    }
    return versioned;
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
      parsed.pathname !== "/api/updates" || parsed.search || parsed.hash) {
    throw new Error("MINT_OTA_URL must be a public HTTPS origin followed by /api/updates.");
  }
  const certificate = process.env.MINT_OTA_CERTIFICATE_PATH;
  if (!certificate) throw new Error("MINT_OTA_CERTIFICATE_PATH is required; unsigned OTA updates are not supported.");
  const channel = process.env.MINT_OTA_CHANNEL || "production";
  if (!["production", "preview"].includes(channel)) throw new Error("MINT_OTA_CHANNEL must be production or preview.");
  const runtime = process.env.MINT_NATIVE_RUNTIME || "fingerprint-pending";
  if (runtime !== "fingerprint-pending" && !/^[a-f0-9]{64}$/.test(runtime)) {
    throw new Error("MINT_NATIVE_RUNTIME must be the 64-character Android native fingerprint.");
  }
  return {
    ...versioned,
    runtimeVersion: runtime,
    updates: {
      ...config.updates,
      enabled: true,
      url,
      requestHeaders: { "expo-channel-name": channel },
      codeSigningCertificate: certificate,
      codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" },
      checkAutomatically: "ON_LOAD",
      fallbackToCacheTimeout: 0,
      useEmbeddedUpdate: true,
      disableAntiBrickingMeasures: false,
    },
  };
};
