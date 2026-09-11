#!/usr/bin/env bash
# Deploys the bullion token + escrow registry to the collateral chain and the ASCRepoDesk to
# Creditcoin, then binds the desk to its registry, its price aggregator, and its risk parameters.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a

: "${SOURCE_CHAIN_RPC_URL:?set SOURCE_CHAIN_RPC_URL}"
: "${DEPLOYER_PRIVATE_KEY:?set DEPLOYER_PRIVATE_KEY}"
CREDITCOIN_RPC_URL="${CREDITCOIN_RPC_URL:-https://rpc.cc3-testnet.creditcoin.network}"
GOLD_AGGREGATOR_ADDRESS="${GOLD_AGGREGATOR_ADDRESS:-0x0e3dd634FFbF7EA89BbDCF09Ccc463302FD5f903}"
ADVANCE_RATE_BPS="${ADVANCE_RATE_BPS:-6000}"
MAINTENANCE_BPS="${MAINTENANCE_BPS:-7500}"

deployed() { node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).deployedTo'; }
create() { forge create "$1" --rpc-url "$2" --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast --json | deployed; }

forge build

echo "==> TestBullion → collateral chain"
BULLION=${BULLION_TOKEN_ADDRESS:-$(create contracts/sol/TestBullion.sol:TestBullion "$SOURCE_CHAIN_RPC_URL")}
echo "    $BULLION"

echo "==> CollateralRegistry → collateral chain"
REGISTRY=$(create contracts/sol/CollateralRegistry.sol:CollateralRegistry "$SOURCE_CHAIN_RPC_URL")
echo "    $REGISTRY"

echo "==> ASCRepoDesk → Creditcoin"
DESK=$(create contracts/sol/ASCRepoDesk.sol:ASCRepoDesk "$CREDITCOIN_RPC_URL")
echo "    $DESK"

send() { cast send "$DESK" "$@" --rpc-url "$CREDITCOIN_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY" >/dev/null; }

echo "==> Binding escrow registry"
send "registerSourceRegistry(address)" "$REGISTRY"
echo "==> Binding Chainlink XAU/USD aggregator"
send "registerPriceAggregator(address)" "$GOLD_AGGREGATOR_ADDRESS"
echo "==> Accepting bullion at ${ADVANCE_RATE_BPS}bps advance / ${MAINTENANCE_BPS}bps maintenance"
send "registerCollateralAsset(address,uint8,uint16,uint16)" "$BULLION" 18 "$ADVANCE_RATE_BPS" "$MAINTENANCE_BPS"

cat <<SUMMARY

Add to .env:
BULLION_TOKEN_ADDRESS=$BULLION
SOURCE_REGISTRY_ADDRESS=$REGISTRY
ASC_REPO_DESK_ADDRESS=$DESK
SUMMARY
