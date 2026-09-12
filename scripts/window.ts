import "dotenv/config";
import { Contract, JsonRpcProvider, Wallet, formatUnits, parseUnits } from "ethers";
import goldWindowAbi from "../contracts/abi/GoldWindow.json" with { type: "json" };
import provedGoldAbi from "../contracts/abi/ProvedGold.json" with { type: "json" };
import testUsdAbi from "../contracts/abi/TestUSD.json" with { type: "json" };
import { loadConfig } from "../src/config.js";

const config = loadConfig();
const provider = new JsonRpcProvider(config.environment.rpcUrl, config.environment.chainId, { staticNetwork: true });
const wallet = new Wallet(process.env.DEPLOYER_PRIVATE_KEY!, provider);
const windowAddress = process.env.GOLD_WINDOW_ADDRESS!;
const win = new Contract(windowAddress, goldWindowAbi as never, wallet);
const gold = new Contract(config.goldAddress!, provedGoldAbi as never, wallet);
const usd = new Contract(process.env.TEST_USD_ADDRESS!, testUsdAbi as never, wallet);
const explorer = (hash: string) => `${config.environment.explorerUrl}/tx/${hash}`;

async function status() {
  const [answer, roundId] = await win.provedRound();
  const mid = await win.midUsdPerGram();
  const [buyUsd, sellUsd] = await win.quote(parseUnits("1", 18));
  const [goldInv, usdInv, spread] = await Promise.all([
    gold.balanceOf(windowAddress), usd.balanceOf(windowAddress), win.spreadBps()
  ]);
  console.log(`\nGoldWindow ${windowAddress}`);
  console.log(`  proved round   $${Number(answer) / 1e8}/oz  (round ${roundId})`);
  console.log(`  mid            $${formatUnits(mid, 6)} / gram`);
  console.log(`  buy / sell     $${formatUnits(buyUsd, 6)}  /  $${formatUnits(sellUsd, 6)}   spread ${spread}bps`);
  console.log(`  inventory      ${formatUnits(goldInv, 18)} g   $${Number(formatUnits(usdInv, 6)).toLocaleString("en-US")}`);
  console.log(`  your balance   ${formatUnits(await gold.balanceOf(wallet.address), 18)} g   $${Number(formatUnits(await usd.balanceOf(wallet.address), 6)).toLocaleString("en-US")}\n`);
}

async function fund() {
  const grams = parseUnits(process.argv[3] ?? "500", 18);
  const dollars = parseUnits(process.argv[4] ?? "200000", 6);
  await (await usd.mint(wallet.address, dollars * 2n)).wait();
  await (await gold.approve(windowAddress, grams)).wait();
  await (await usd.approve(windowAddress, dollars)).wait();
  const tx = await win.fund(grams, dollars);
  console.log(`fund  ${explorer(tx.hash)}`);
  await tx.wait();
  await status();
}

async function buy() {
  const grams = parseUnits(process.argv[3] ?? "5", 18);
  const [buyUsd] = await win.quote(grams);
  await (await usd.approve(windowAddress, buyUsd)).wait();
  const tx = await win.buy(grams);
  console.log(`buy   ${explorer(tx.hash)}`);
  await tx.wait();
  await status();
}

async function sell() {
  const grams = parseUnits(process.argv[3] ?? "5", 18);
  await (await gold.approve(windowAddress, grams)).wait();
  const tx = await win.sell(grams);
  console.log(`sell  ${explorer(tx.hash)}`);
  await tx.wait();
  await status();
}

const commands: Record<string, () => Promise<void>> = { status, fund, buy, sell };
const command = process.argv[2] ?? "status";
if (!commands[command]) { console.error("usage: tsx scripts/window.ts <status|fund|buy|sell> [amount]"); process.exit(1); }
await commands[command]();
