import { chainsForRole, resolveEnvironment, type CreditcoinEnvironment } from "./creditcoin.js";

export type Mode = "read-only" | "proving";

export interface WatchedChain {
  role: "collateral" | "price" | "reserves";
  name: string;
  chainKey: number;
  rpcUrl?: string;
  emitter?: string;
}

export interface AppConfig {
  mode: Mode;
  port: number;
  environment: CreditcoinEnvironment;
  collateral: WatchedChain;
  price: WatchedChain;
  reserves: WatchedChain;
  deskAddress?: string;
  goldAddress?: string;
  workerPrivateKey?: string;
  workerFromBlock?: number;
  priceFromBlock?: number;
  reserveFromBlock?: number;
}

/** Treats an empty environment variable as unset, so `.env` placeholders do not win over defaults. */
function env(name: string) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

export function loadConfig(): AppConfig {
  const environment = resolveEnvironment();
  const collateralChain = chainsForRole(environment, "collateral")[0];
  const priceChain = environment.sourceChains.find((chain) => chain.chainKey === environment.goldFeed.chainKey);
  if (!priceChain) throw new Error("The configured gold feed is not on an attested chain");

  const collateral: WatchedChain = {
    role: "collateral",
    name: collateralChain.name,
    chainKey: Number(env("SOURCE_CHAIN_KEY") ?? collateralChain.chainKey),
    rpcUrl: env("SOURCE_CHAIN_RPC_URL"),
    emitter: env("SOURCE_REGISTRY_ADDRESS")
  };

  const price: WatchedChain = {
    role: "price",
    name: priceChain.name,
    chainKey: environment.goldFeed.chainKey,
    rpcUrl: env("PRICE_CHAIN_RPC_URL"),
    emitter: env("GOLD_AGGREGATOR_ADDRESS") ?? environment.goldFeed.aggregator
  };

  const reserves: WatchedChain = {
    role: "reserves",
    name: priceChain.name,
    chainKey: environment.goldFeed.chainKey,
    rpcUrl: env("PRICE_CHAIN_RPC_URL"),
    emitter: env("RESERVE_FEED_ADDRESS") ?? environment.reserveFeed.aggregator
  };

  const workerPrivateKey = env("PROOF_WORKER_PRIVATE_KEY");
  const deskAddress = env("ASC_REPO_DESK_ADDRESS");
  const proving = Boolean(workerPrivateKey && collateral.rpcUrl && collateral.emitter && deskAddress);

  return {
    mode: proving ? "proving" : "read-only",
    port: Number(env("PORT") ?? 3000),
    environment,
    collateral,
    price,
    reserves,
    deskAddress,
    goldAddress: env("PROVED_GOLD_ADDRESS"),
    workerPrivateKey,
    workerFromBlock: env("WORKER_FROM_BLOCK") ? Number(env("WORKER_FROM_BLOCK")) : undefined,
    priceFromBlock: env("PRICE_FROM_BLOCK") ? Number(env("PRICE_FROM_BLOCK")) : undefined,
    reserveFromBlock: env("RESERVE_FROM_BLOCK") ? Number(env("RESERVE_FROM_BLOCK")) : undefined
  };
}
