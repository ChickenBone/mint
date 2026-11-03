import path from "node:path";
import type { NextConfig } from "next";

const dev = process.env.NODE_ENV === "development";
// Headers are baked in at build time, so stay origin-agnostic: 'self' covers same-origin wss:// for /ws.
const extraConnect = [process.env.NEXT_PUBLIC_WS_URL, dev && "ws://localhost:3001"].filter(Boolean).join(" ");

const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'" + (dev ? " 'unsafe-eval'" : ""),
  "style-src 'self' 'unsafe-inline'",
  // Cover art is always remote: Cover Art Archive (redirects to archive.org) or YouTube thumbnails.
  "img-src 'self' data: blob: https://i.ytimg.com https://*.ggpht.com https://*.googleusercontent.com https://coverartarchive.org https://archive.org https://*.archive.org",
  "media-src 'none'",
  "font-src 'self'",
  `connect-src 'self' ${extraConnect}`.trim(),
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self' https://accounts.google.com",
  "object-src 'none'",
].join("; ");

const config: NextConfig = {
  // Vercel builds its own output; standalone is for the self-hosted Docker image.
  output: process.env.VERCEL ? undefined : "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../../"),
  transpilePackages: ["@mint/core"],
  serverExternalPackages: ["@node-rs/argon2", "bullmq", "pg", "ioredis"],
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
      {
        source: "/sw.js",
        headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }, { key: "Service-Worker-Allowed", value: "/" }],
      },
      {
        source: "/app/:path*",
        headers: [{ key: "Content-Security-Policy", value: csp.replace("media-src 'none'", "media-src 'self'") }],
      },
    ];
  },
};

export default config;
