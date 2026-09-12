import type { AppConfig } from "./config.js";
import type { ChainWatchConfig, ProofWorkerConfig } from "./proof-worker.js";

/**
 * Builds the watch list, skipping any chain whose RPC or target contract is unconfigured.
 * Each watch names its own target: custody and price proofs drive the repo desk, reserve
 * proofs drive the gold token.
 */
export function buildWorkerConfig(config: AppConfig): ProofWorkerConfig | null {
  if (!config.workerPrivateKey) return null;

  const watches: ChainWatchConfig[] = [];

  if (config.deskAddress && config.collateral.rpcUrl && config.collateral.emitter) {
    watches.push({
      role: "collateral",
      name: config.collateral.name,
      chainKey: config.collateral.chainKey,
      rpcUrl: config.collateral.rpcUrl,
      emitter: config.collateral.emitter,
      target: config.deskAddress,
      fromBlock: config.workerFromBlock
    });
  }

  if (config.deskAddress && config.price.rpcUrl && config.price.emitter) {
    watches.push({
      role: "price",
      name: config.price.name,
      chainKey: config.price.chainKey,
      rpcUrl: config.price.rpcUrl,
      emitter: config.price.emitter,
      target: config.deskAddress,
      fromBlock: config.priceFromBlock
    });
  }

  if (config.goldAddress && config.reserves.rpcUrl && config.reserves.emitter) {
    watches.push({
      role: "reserves",
      name: config.reserves.name,
      chainKey: config.reserves.chainKey,
      rpcUrl: config.reserves.rpcUrl,
      emitter: config.reserves.emitter,
      target: config.goldAddress,
      fromBlock: config.reserveFromBlock
    });
  }

  // Every listed asset's feed rides the same proof path; only its target differs.
  for (const feed of config.listedFeeds) {
    if (!config.price.rpcUrl) break;
    watches.push({
      role: "reserves",
      name: feed.name,
      chainKey: config.price.chainKey,
      rpcUrl: config.price.rpcUrl,
      emitter: feed.aggregator,
      target: feed.target,
      fromBlock: feed.fromBlock
    });
  }

  if (!watches.length) return null;

  return { environment: config.environment, privateKey: config.workerPrivateKey, watches };
}
