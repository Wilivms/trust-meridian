#!/usr/bin/env bash
# Deploys Settle, Circle and Claim to testnet. Needs DEPLOYER_SECRET and USDC_ID.
set -euo pipefail
NET=testnet
W=${WASM_DIR:-wasm}
stellar keys add deployer --secret-key <<< "$DEPLOYER_SECRET" >/dev/null 2>&1 || true
ADMIN=$(stellar keys address deployer)
curl -s "https://friendbot.stellar.org/?addr=$ADMIN" >/dev/null || true
USDC=${USDC_ID:?set the USDC_ID repository variable}
dep() { stellar contract deploy --wasm "$W/$1.wasm" --source-account deployer --network $NET -- "${@:2}"; }
SETTLE=$(dep tm_settle --token "$USDC")
CIRCLE=$(dep tm_circle --admin "$ADMIN" --token "$USDC" --settle "$SETTLE")
CLAIM=$(dep tm_claim --token "$USDC" --treasury "$ADMIN" --fee 1000000)
mkdir -p deployments
cat > deployments/testnet.json <<JSON
{ "network": "testnet", "admin": "$ADMIN", "usdc": "$USDC", "settle": "$SETTLE", "circle": "$CIRCLE", "claim": "$CLAIM" }
JSON
cat deployments/testnet.json
{ echo "### Testnet deployment"; echo '```json'; cat deployments/testnet.json; echo '```'; } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
