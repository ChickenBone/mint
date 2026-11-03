#!/bin/sh
# Shared entrypoint for the web, worker, hub and realtime images.
# Fills in anything not set in the environment from the secrets the `init` service generated,
# then derives the connection defaults for the all-in-one compose stack.
set -e

secrets="${MINT_SECRETS_FILE:-/secrets/mint.env}"
if [ -r "$secrets" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | \#*) continue ;; esac
    key="${line%%=*}"
    if [ -z "$(printenv "$key" || true)" ]; then export "$line"; fi
  done < "$secrets"
fi

if [ -z "${PUBLIC_URL:-}" ]; then
  if [ -n "${MINT_DOMAIN:-}" ]; then PUBLIC_URL="https://${MINT_DOMAIN}"; else PUBLIC_URL="http://localhost"; fi
  export PUBLIC_URL
fi
if [ -z "${DATABASE_URL:-}" ] && [ -n "${POSTGRES_PASSWORD:-}" ]; then
  export DATABASE_URL="postgres://mint:${POSTGRES_PASSWORD}@postgres:5432/mint"
fi
[ -n "${REDIS_URL:-}" ] || export REDIS_URL="redis://redis:6379"

exec "$@"
