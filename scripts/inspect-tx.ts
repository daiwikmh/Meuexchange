import "dotenv/config";
import { Contract, JsonRpcProvider } from "ethers";
import ascRepoDeskAbi from "../contracts/abi/ASCRepoDesk.json" with { type: "json" };
import { loadConfig } from "../src/config.js";

const config = loadConfig();
const hash = process.argv[2];
if (!hash) { console.error("usage: tsx scripts/inspect-tx.ts <creditcoin tx hash>"); process.exit(1); }

const provider = new JsonRpcProvider(config.environment.rpcUrl, config.environment.chainId, { staticNetwork: true });
const desk = new Contract(config.deskAddress!, ascRepoDeskAbi as never, provider);
const transaction = await provider.getTransaction(hash);
if (!transaction) {
  console.log(`\n${hash}\n  not found on ${config.environment.network}\n`);
  process.exit(1);
}
const receipt = await provider.waitForTransaction(hash, 1, 180_000);

console.log(`\n${config.environment.explorerUrl}/tx/${hash}`);
console.log(`  status     ${receipt === null ? "PENDING (not mined within 180s)" : receipt.status === 1 ? "SUCCESS" : "REVERTED"}`);
console.log(`  block      ${receipt?.blockNumber}`);
console.log(`  gas used   ${receipt?.gasUsed}`);
console.log(`  calldata   ${transaction?.data.length ? (transaction.data.length - 2) / 2 : 0} bytes`);
console.log(`  logs       ${receipt?.logs.length}`);
for (const log of receipt?.logs ?? []) {
  let parsed = null;
  try { parsed = desk.interface.parseLog({ topics: [...log.topics], data: log.data }); } catch { /* not ours */ }
  console.log(parsed ? `    ${parsed.name}(${parsed.args.map(String).join(", ")})` : `    [log from ${log.address}]`);
}
console.log();
