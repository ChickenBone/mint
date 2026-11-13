#!/bin/sh
set -eu

MINT_TARGET_GATEWAY_TOKEN="$(cat /run/secrets/target_gateway_token)"
MINT_TARGET_INGRESS_TOKEN="$(cat /run/secrets/target_ingress_token)"
export MINT_TARGET_GATEWAY_TOKEN MINT_TARGET_INGRESS_TOKEN
exec mint-entrypoint "$@"
