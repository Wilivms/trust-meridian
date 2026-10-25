#!/usr/bin/env bash
# Read-only checks of the partner deployments on testnet.
set -u
RPC=https://soroban-testnet.stellar.org
echo "== network"; curl -s $RPC -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getNetwork"}'; echo
curl -s $RPC -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getVersionInfo"}'; echo
echo "== XOXNO assets"; curl -s https://testnet-api.xoxno.com/stellar-lending/v1/assets | head -c 6000; echo
echo "== DeFindex testnet contracts"; curl -s https://raw.githubusercontent.com/paltalabs/defindex/main/apps/contracts/public/testnet.contracts.json; echo
echo "== DeFindex API"; curl -s https://api.defindex.io/ | head -c 1500; echo
echo "== Circle USDC SAC (testnet issuer)"; stellar contract id asset --asset USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 --network testnet
echo "== XLM SAC"; stellar contract id asset --asset native --network testnet
echo "== Trustless Work"; curl -s -o /dev/null -w "%{http_code}\n" https://dev.api.trustlesswork.com/docs
echo "== Soroswap API"; curl -s https://api.soroswap.finance/api/testnet/tokens 2>/dev/null | head -c 2000; echo
echo "== OZ channels"; curl -s -o /dev/null -w "%{http_code}\n" https://channels.openzeppelin.com/testnet
echo "== testanchor"; curl -s https://testanchor.stellar.org/.well-known/stellar.toml | head -30
