#!/bin/sh
set -eu

MINT_API_DB_PASSWORD="$(cat /run/secrets/target_db_password)"
MINT_API_GATEWAY_TOKEN="$(cat /run/secrets/target_gateway_token)"
export MINT_API_DB_PASSWORD MINT_API_GATEWAY_TOKEN
if [ -f /run/secrets/target_admin_password ]; then
  MINT_API_BOOTSTRAP_ADMIN_PASSWORD="$(cat /run/secrets/target_admin_password)"
  export MINT_API_BOOTSTRAP_ADMIN_PASSWORD
fi
exec "$@"
