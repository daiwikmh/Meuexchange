import "dotenv/config";
import { Contract, JsonRpcProvider, Wallet, formatUnits, parseUnits } from "ethers";
import provedGoldAbi from "../contracts/abi/ProvedGold.json" with { type: "json" };
import { loadConfig } from "../src/config.js";

const config = loadConfig();
const provider = new JsonRpcProvider(config.environment.rpcUrl, config.environment.chainId, { staticNetwork: true });
const wallet = new Wallet(process.env.DEPLOYER_PRIVATE_KEY!, provider);
const gold = new Contract(config.goldAddress!, provedGoldAbi as never, wallet);
const GRAMS_PER_TROY_OUNCE = 31.1034768;

async function status() {
  const [reserves, round, updatedAt, supply, room, feed] = await Promise.all([
    gold.provedReserves(), gold.reserveRoundId(), gold.reserveUpdatedAt(),
    gold.totalSupply(), gold.headroom(), gold.reserveFeed()
  ]);
  const grams = Number(formatUnits(reserves, 18));
  console.log(`\nProvedGold ${config.goldAddress}`);
  console.log(`  reserve feed     ${feed}`);
  if (reserves === 0n) { console.log("  proved reserves  none yet\n"); return; }
  console.log(`  proved reserves  ${grams.toLocaleString('en-US', { maximumFractionDigits: 3 })} g  (${(grams / GRAMS_PER_TROY_OUNCE).toLocaleString('en-US', { maximumFractionDigits: 1 })} troy oz)`);
  console.log(`  round            ${round}  as of ${new Date(Number(updatedAt) * 1000).toISOString()}`);
  console.log(`  total supply     ${Number(formatUnits(supply, 18)).toLocaleString('en-US')} g`);
  console.log(`  issuable now     ${Number(formatUnits(room, 18)).toLocaleString('en-US')} g\n`);
}

async function issue() {
  const grams = parseUnits(process.argv[3] ?? "1000", 18);
  const tx = await gold.issue(wallet.address, grams);
  console.log(`issue  ${config.environment.explorerUrl}/tx/${tx.hash}`);
  await tx.wait();
  await status();
}

const commands: Record<string, () => Promise<void>> = { status, issue };
const command = process.argv[2] ?? "status";
if (!commands[command]) { console.error(`usage: tsx scripts/gold.ts <status|issue> [grams]`); process.exit(1); }
await commands[command]();
