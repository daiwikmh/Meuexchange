import "dotenv/config";
import { Contract, JsonRpcProvider } from "ethers";
import ascRepoDeskAbi from "../contracts/abi/ASCRepoDesk.json" with { type: "json" };
import { loadConfig } from "../src/config.js";

const config = loadConfig();
const provider = new JsonRpcProvider(config.environment.rpcUrl, config.environment.chainId, { staticNetwork: true });
const desk = new Contract(config.deskAddress!, ascRepoDeskAbi as never, provider);
const bullion = process.env.BULLION_TOKEN_ADDRESS!;

const expect = (label: string, actual: string, wanted: string) =>
  console.log(`  ${actual.toLowerCase() === wanted.toLowerCase() ? "ok  " : "FAIL"}  ${label}: ${actual}`);

console.log(`\nASCRepoDesk ${config.deskAddress} on ${config.environment.network}\n`);
console.log(`  code deployed: ${((await provider.getCode(config.deskAddress!)).length - 2) / 2} bytes`);
expect("owner", await desk.OWNER(), process.env.DEPLOYER_ADDRESS ?? (await desk.OWNER()));
expect("sourceRegistry", await desk.sourceRegistry(), config.collateral.emitter!);
expect("priceAggregator", await desk.priceAggregator(), config.price.emitter!);

const asset = await desk.collateralAssets(bullion);
console.log(
  `  ${asset.accepted ? "ok  " : "FAIL"}  bullion ${bullion}: accepted=${asset.accepted} decimals=${asset.decimals} advance=${asset.advanceRateBps}bps maintenance=${asset.maintenanceBps}bps`
);

const price = await desk.goldPrice();
console.log(`  ${price.answer === 0n ? "--  " : "ok  "}  goldPrice: ${price.answer === 0n ? "no round proved yet" : price.answer}`);
console.log(`\n  verifier precompile: ${await desk.VERIFIER()}\n`);
