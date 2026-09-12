import "dotenv/config";
import { Contract, JsonRpcProvider, Wallet, parseEther, keccak256, toUtf8Bytes } from "ethers";
import ascRepoDeskAbi from "../contracts/abi/ASCRepoDesk.json" with { type: "json" };
import { loadConfig } from "../src/config.js";

const config = loadConfig();
const provider = new JsonRpcProvider(config.environment.rpcUrl, config.environment.chainId, { staticNetwork: true });
const wallet = new Wallet(process.env.DEPLOYER_PRIVATE_KEY!, provider);
const desk = new Contract(config.deskAddress!, ascRepoDeskAbi as never, wallet);
const agreementId = keccak256(toUtf8Bytes(process.env.DEMO_LABEL ?? "MEU-GOLD-DEMO-1"));

try {
  await desk.drawPrincipal.staticCall(agreementId, { value: parseEther("40") });
  console.log("drawPrincipal would SUCCEED");
} catch (error) {
  const data = (error as { data?: string }).data;
  if (!data) { console.log("revert, no data:", (error as Error).message.slice(0, 120)); process.exit(0); }
  const parsed = desk.interface.parseError(data);
  console.log(`drawPrincipal REVERTS with ${parsed?.name}(${parsed?.args.map(String).join(", ")})`);
  console.log(`  raw selector ${data.slice(0, 10)}`);
}
