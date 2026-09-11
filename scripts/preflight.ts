import "dotenv/config";
import { Contract, JsonRpcProvider, Wallet, formatEther } from "ethers";
import { chainInfo } from "@gluwa/usc-sdk";
import { loadConfig } from "../src/config.js";

const ANSWER_UPDATED = "event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)";
const config = loadConfig();
const { environment } = config;
let blocking = 0;

const ok = (line: string) => console.log(`  ok    ${line}`);
const warn = (line: string) => console.log(`  warn  ${line}`);
const fail = (line: string) => {
  blocking += 1;
  console.log(`  FAIL  ${line}`);
};

async function reachable(label: string, rpcUrl: string | undefined, expectedChainId: number) {
  if (!rpcUrl) {
    fail(`${label}: no RPC configured`);
    return null;
  }
  try {
    const provider = new JsonRpcProvider(rpcUrl);
    const network = await provider.getNetwork();
    const head = await provider.getBlockNumber();
    if (Number(network.chainId) !== expectedChainId) {
      fail(`${label}: RPC reports chain ${network.chainId}, expected ${expectedChainId}`);
      return null;
    }
    ok(`${label}: chain ${expectedChainId}, head ${head}`);
    return { provider, head };
  } catch (error) {
    fail(`${label}: unreachable — ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

console.log(`\nMEU Exchange preflight — ${environment.network}\n`);

console.log("Networks");
const creditcoin = await reachable("Creditcoin", environment.rpcUrl, environment.chainId);
const collateralChainId = environment.sourceChains.find((c) => c.chainKey === config.collateral.chainKey)?.chainId;
const collateral = await reachable(`Collateral · ${config.collateral.name}`, config.collateral.rpcUrl, collateralChainId!);
const priceChainId = environment.sourceChains.find((c) => c.chainKey === config.price.chainKey)?.chainId;
const price = await reachable(`Price · ${config.price.name}`, config.price.rpcUrl, priceChainId!);

console.log("\nAttestation coverage");
if (creditcoin) {
  const info = new chainInfo.PrecompileChainInfoProvider(creditcoin.provider as never);
  const supported = await info.getSupportedChains();
  for (const watch of [config.collateral, config.price]) {
    const entry = supported.find((chain) => Number(chain.chainKey) === watch.chainKey);
    if (!entry) {
      fail(`chainKey ${watch.chainKey} (${watch.name}) is not attested by ${environment.network}`);
      continue;
    }
    const latest = await info.getLatestAttestedHeightAndHash(watch.chainKey);
    const head = watch.role === "collateral" ? collateral?.head : price?.head;
    const lag = head ? head - Number(latest.height) : null;
    ok(`chainKey ${watch.chainKey} ${watch.name}: attested ${latest.height}${lag === null ? "" : ` (${lag} blocks behind head)`}`);
  }
}

console.log("\nGold feed");
if (price) {
  try {
    const aggregator = new Contract(config.price.emitter!, [ANSWER_UPDATED], price.provider);
    const from = Math.max(0, price.head - 45);
    const logs = await aggregator.queryFilter("AnswerUpdated", from, price.head);
    ok(`aggregator ${config.price.emitter} responds to log queries`);
    if (logs.length) ok(`${logs.length} AnswerUpdated round(s) in the last 45 blocks`);
    else warn(`no round in the last 45 blocks — set PRICE_FROM_BLOCK to backfill a known round`);
  } catch (error) {
    fail(`aggregator log query failed — ${error instanceof Error ? error.message : error}`);
  }
}

console.log("\nDeployer");
const key = process.env.DEPLOYER_PRIVATE_KEY?.trim();
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  fail("DEPLOYER_PRIVATE_KEY is missing or malformed (expected 0x + 64 hex chars)");
} else {
  const address = new Wallet(key).address;
  ok(`address ${address}`);
  for (const [label, target] of [["Creditcoin", creditcoin], ["Collateral chain", collateral]] as const) {
    if (!target) continue;
    const balance = await target.provider.getBalance(address);
    if (balance === 0n) fail(`${label}: 0 balance — fund this account before deploying`);
    else ok(`${label}: ${formatEther(balance)}`);
  }
}

console.log(
  blocking === 0
    ? "\nReady. Run ./scripts/deploy.sh\n"
    : `\n${blocking} blocking issue(s) — deploy will fail until they are fixed.\n`
);
process.exit(blocking === 0 ? 0 : 1);
