import "dotenv/config";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { AgreementIndex, ProofLedger } from "./domain.js";
import { RepoDeskGateway } from "./gateway.js";
import { ProofWorker } from "./proof-worker.js";
import { buildWorkerConfig } from "./worker-setup.js";

const config = loadConfig();
const ledger = new ProofLedger();
const index = new AgreementIndex();
const desk = new RepoDeskGateway(config.environment, config.deskAddress);

if (process.env.INLINE_WORKER === "true") {
  const workerConfig = buildWorkerConfig(config);
  if (workerConfig) void new ProofWorker(workerConfig, ledger).start();
  else console.warn("INLINE_WORKER is set but the worker is not configured; serving read-only.");
}

serve({ fetch: createApp(config, desk, ledger, index).fetch, port: config.port });
console.log(`MEU Exchange API on :${config.port} — ${config.environment.network} (${config.mode})`);
console.log(`ASCRepoDesk: ${config.deskAddress ?? "not configured"}`);
