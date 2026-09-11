import "dotenv/config";
import { JsonRpcProvider } from "ethers";
import { chainInfo } from "@gluwa/usc-sdk";
import { resolveEnvironment } from "../src/creditcoin.js";

const environment = resolveEnvironment();
const provider = new JsonRpcProvider(environment.rpcUrl, environment.chainId, { staticNetwork: true });
const info = new chainInfo.PrecompileChainInfoProvider(provider as never);

console.log(`${environment.network} head: ${await provider.getBlockNumber()}`);

for (const chain of await info.getSupportedChains()) {
  const latest = await info.getLatestAttestedHeightAndHash(Number(chain.chainKey));
  console.log(
    `chainKey ${chain.chainKey} · chainId ${chain.chainId} · ${chain.chainName} · attested height ${latest.height}`
  );
}
