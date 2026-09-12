import "dotenv/config";
import { Contract, JsonRpcProvider, Wallet, parseUnits } from "ethers";
import provedGoldAbi from "../contracts/abi/ProvedGold.json" with { type: "json" };
import { loadConfig } from "../src/config.js";

const config = loadConfig();
const provider = new JsonRpcProvider(config.environment.rpcUrl, config.environment.chainId, { staticNetwork: true });
const wallet = new Wallet(process.env.DEPLOYER_PRIVATE_KEY!, provider);
const gold = new Contract(config.goldAddress!, provedGoldAbi as never, wallet);

try {
  await gold.issue.staticCall(wallet.address, parseUnits(process.argv[2] ?? "1000", 18));
  console.log("issue would SUCCEED");
} catch (error) {
  const data = (error as { data?: string }).data;
  if (!data) { console.log("reverts:", (error as Error).message.slice(0, 140)); process.exit(0); }
  const parsed = gold.interface.parseError(data);
  console.log(`issue REVERTS with ${parsed?.name}(${parsed?.args.map(String).join(", ")})  selector ${data.slice(0, 10)}`);
}
