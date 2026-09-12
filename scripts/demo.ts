import "dotenv/config";
import { Contract, JsonRpcProvider, Wallet, formatEther, parseEther, parseUnits, keccak256, toUtf8Bytes } from "ethers";
import ascRepoDeskAbi from "../contracts/abi/ASCRepoDesk.json" with { type: "json" };
import collateralRegistryAbi from "../contracts/abi/CollateralRegistry.json" with { type: "json" };
import { statusByIndex } from "../src/domain.js";
import { loadConfig } from "../src/config.js";

const bullionAbi = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)"
];

const config = loadConfig();
const label = process.env.DEMO_LABEL ?? "MEU-GOLD-DEMO-1";
const agreementId = keccak256(toUtf8Bytes(label));

const OUNCES = parseEther("10");
const PRINCIPAL = parseEther("40");
const PRINCIPAL_USD = parseUnits("20000", 8);
const REPAYMENT = parseEther("1");

const key = process.env.DEPLOYER_PRIVATE_KEY!;
const creditcoin = new JsonRpcProvider(config.environment.rpcUrl, config.environment.chainId, { staticNetwork: true });
const sepolia = new JsonRpcProvider(config.collateral.rpcUrl!);
const ccWallet = new Wallet(key, creditcoin);
const ethWallet = new Wallet(key, sepolia);

const desk = new Contract(config.deskAddress!, ascRepoDeskAbi as never, ccWallet);
const registry = new Contract(config.collateral.emitter!, collateralRegistryAbi as never, ethWallet);
const bullion = new Contract(process.env.BULLION_TOKEN_ADDRESS!, bullionAbi, ethWallet);

const explorer = (hash: string) => `${config.environment.explorerUrl}/tx/${hash}`;

async function status() {
  const agreement = await desk.getAgreement(agreementId);
  const price = await desk.goldPrice();
  console.log(`\nagreement ${label}`);
  console.log(`  id          ${agreementId}`);
  console.log(`  status      ${statusByIndex[Number(agreement.status)]}`);
  console.log(`  collateral  ${formatEther(agreement.collateralAmount)} oz  (${agreement.collateralToken})`);
  console.log(`  principal   ${formatEther(agreement.principal)} tCTC / $${Number(agreement.principalUsd) / 1e8}`);
  console.log(`  repaid      ${formatEther(agreement.repaid)} / ${formatEther(agreement.requiredRepayment)} oz`);
  console.log(`  marginCall  ${agreement.marginCalled}`);
  console.log(`\ngold price`);
  if (price.answer === 0n) {
    console.log("  none proved yet");
  } else {
    console.log(`  $${Number(price.answer) / 1e8}/oz  round ${price.roundId}  updated ${new Date(Number(price.updatedAt) * 1000).toISOString()}`);
    if (agreement.collateralAmount > 0n) {
      const value = await desk.collateralValueUsd(agreementId);
      console.log(`  collateral worth $${(Number(value) / 1e8).toLocaleString()}  →  max advance $${((Number(value) / 1e8) * 0.6).toLocaleString()}`);
    }
  }
  console.log();
}

async function terms() {
  const maturity = Math.floor(Date.now() / 1000) + 7 * 86_400;
  const tx = await desk.offerTerms(agreementId, ccWallet.address, ethWallet.address, PRINCIPAL, PRINCIPAL_USD, REPAYMENT, maturity);
  console.log(`offerTerms  ${explorer(tx.hash)}`);
  await tx.wait();
  console.log("status → offered");
}

async function pledge() {
  const balance = await bullion.balanceOf(ethWallet.address);
  if (balance < OUNCES + REPAYMENT) {
    const tx = await bullion.mint(ethWallet.address, OUNCES + REPAYMENT);
    console.log(`mint        ${tx.hash}`);
    await tx.wait();
  }
  const approve = await bullion.approve(await registry.getAddress(), OUNCES + REPAYMENT);
  await approve.wait();
  console.log(`approve     ${approve.hash}`);

  const tx = await registry.pledge(agreementId, await bullion.getAddress(), OUNCES, ccWallet.address);
  console.log(`pledge      https://sepolia.etherscan.io/tx/${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`mined in block ${receipt.blockNumber} — the worker will prove it to Creditcoin`);
}

async function draw() {
  const tx = await desk.drawPrincipal(agreementId, { value: PRINCIPAL });
  console.log(`drawPrincipal ${explorer(tx.hash)}`);
  await tx.wait();
  console.log("status → funded");
}

async function repay() {
  const tx = await registry.recordPayment(agreementId, REPAYMENT);
  console.log(`recordPayment https://sepolia.etherscan.io/tx/${tx.hash}`);
  await tx.wait();
}

async function release() {
  const tx = await registry.release(agreementId);
  console.log(`release       https://sepolia.etherscan.io/tx/${tx.hash}`);
  await tx.wait();
}

const commands: Record<string, () => Promise<void>> = { status, terms, pledge, draw, repay, release };
const command = process.argv[2];

if (!commands[command]) {
  console.error(`usage: tsx scripts/demo.ts <${Object.keys(commands).join("|")}>`);
  process.exit(1);
}

await commands[command]();
