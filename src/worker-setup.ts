import type { AppConfig } from "./config.js";
import type { ChainWatchConfig, ProofWorkerConfig } from "./proof-worker.js";

/** Builds the watch list, skipping any chain whose RPC is not configured. */
export function buildWorkerConfig(config: AppConfig): ProofWorkerConfig | null {
  if (!config.deskAddress || !config.workerPrivateKey) return null;

  const watches: ChainWatchConfig[] = [];

  if (config.collateral.rpcUrl && config.collateral.emitter) {
    watches.push({
      role: "collateral",
      name: config.collateral.name,
      chainKey: config.collateral.chainKey,
      rpcUrl: config.collateral.rpcUrl,
      emitter: config.collateral.emitter,
      fromBlock: config.workerFromBlock
    });
  }

  if (config.price.rpcUrl && config.price.emitter) {
    watches.push({
      role: "price",
      name: config.price.name,
      chainKey: config.price.chainKey,
      rpcUrl: config.price.rpcUrl,
      emitter: config.price.emitter,
      fromBlock: config.priceFromBlock
    });
  }

  if (!watches.length) return null;

  return {
    environment: config.environment,
    deskAddress: config.deskAddress,
    privateKey: config.workerPrivateKey,
    watches
  };
}
