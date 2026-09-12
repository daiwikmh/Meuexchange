import "dotenv/config";
import { Contract, JsonRpcProvider } from "ethers";
import ascRepoDeskAbi from "../contracts/abi/ASCRepoDesk.json" with { type: "json" };
import { loadConfig } from "../src/config.js";

const config = loadConfig();
const hash = process.argv[2];
if (!hash) { console.error("usage: tsx scripts/inspect-tx.ts <creditcoin tx hash>"); process.exit(1); }

const provider = new JsonRpcProvider(config.environment.rpcUrl, config.environment.chainId, { staticNetwork: true });
const desk = new Contract(config.deskAddress!, ascRepoDeskAbi as never, provider);
const receipt = await provider.getTransactionReceipt(hash);
const transaction = await provider.getTransaction(hash);

console.log(`\n${config.environment.explorerUrl}/tx/${hash}`);
console.log(`  status     ${receipt?.status === 1 ? "SUCCESS" : "FAILED"}`);
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
