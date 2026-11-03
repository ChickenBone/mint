# syntax=docker/dockerfile:1.7
# One Dockerfile, three images: --target web | worker | realtime

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo

# ---- full dependency tree for building ----
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/realtime/package.json apps/realtime/
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
ARG NEXT_PUBLIC_WS_URL=""
ENV NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL}
RUN npm run build -w @mint/worker -w @mint/realtime \
 && npm run build -w @mint/web

# ---- production node_modules scoped to a single workspace ----
FROM deps AS worker-deps
RUN --mount=type=cache,target=/root/.npm rm -rf node_modules && npm ci --omit=dev -w @mint/worker --no-audit --no-fund

FROM deps AS realtime-deps
RUN --mount=type=cache,target=/root/.npm rm -rf node_modules && npm ci --omit=dev -w @mint/realtime --no-audit --no-fund

# ---- web: Next.js standalone server ----
FROM node:${NODE_VERSION}-bookworm-slim AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]

# ---- worker: pipeline, needs ffmpeg ----
FROM node:${NODE_VERSION}-bookworm-slim AS worker
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HEALTH_PORT=8080 MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=worker-deps /repo/node_modules ./node_modules
COPY --from=build /repo/apps/worker/dist ./dist
COPY --from=build /repo/packages/core/migrations ./migrations
RUN mkdir -p /data/previews /data/staging /music /blackhole && chown -R node:node /data /music /blackhole
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["tini", "--"]
CMD ["node", "--enable-source-maps", "dist/index.js"]

# ---- realtime: WebSocket gateway ----
FROM node:${NODE_VERSION}-bookworm-slim AS realtime
ENV NODE_ENV=production PORT=3001
WORKDIR /app
COPY --from=realtime-deps /repo/node_modules ./node_modules
COPY --from=build /repo/apps/realtime/dist ./dist
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/index.js"]
