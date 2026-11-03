import pino from "pino";

export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "mint-worker" },
  redact: ["*.token", "*.apiKey", "*.authorization", "*.refresh_token", "*.access_token"],
});
