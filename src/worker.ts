import "dotenv/config";
import { loadConfig } from "./config.js";
import { ProofLedger } from "./domain.js";
import { ProofWorker } from "./proof-worker.js";
import { buildWorkerConfig } from "./worker-setup.js";

const config = loadConfig();
const workerConfig = buildWorkerConfig(config);

if (!workerConfig) {
  console.error(
    "Proof worker needs ASC_REPO_DESK_ADDRESS, PROOF_WORKER_PRIVATE_KEY, and at least one of:\n" +
      "  collateral chain — SOURCE_CHAIN_RPC_URL + SOURCE_REGISTRY_ADDRESS\n" +
      "  price chain      — PRICE_CHAIN_RPC_URL (the gold aggregator address defaults to the known feed)"
  );
  process.exit(1);
}

const worker = new ProofWorker(workerConfig, new ProofLedger());

process.on("SIGINT", () => worker.stop());
process.on("SIGTERM", () => worker.stop());

void worker.start();
