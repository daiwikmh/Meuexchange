#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
forge build
for name in ASCRepoDesk CollateralRegistry ProvedGold GoldWindow TestUSD; do
  node -e "
    const artifact = require('./contracts/out/${name}.sol/${name}.json');
    require('fs').writeFileSync('./contracts/abi/${name}.json', JSON.stringify(artifact.abi, null, 2) + '\n');
  "
  echo "contracts/abi/${name}.json"
done
