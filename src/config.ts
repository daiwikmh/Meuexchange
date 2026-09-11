import { chainsForRole, resolveEnvironment, type CreditcoinEnvironment } from "./creditcoin.js";

export type Mode = "read-only" | "proving";

export interface WatchedChain {
  role: "collateral" | "price";
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
  deskAddress?: string;
  workerPrivateKey?: string;
  workerFromBlock?: number;
  priceFromBlock?: number;
}

export function loadConfig(): AppConfig {
  const environment = resolveEnvironment();
  const collateralChain = chainsForRole(environment, "collateral")[0];
  const priceChain = environment.sourceChains.find((chain) => chain.chainKey === environment.goldFeed.chainKey);
  if (!priceChain) throw new Error("The configured gold feed is not on an attested chain");

  const collateral: WatchedChain = {
    role: "collateral",
    name: collateralChain.name,
    chainKey: Number(process.env.SOURCE_CHAIN_KEY ?? collateralChain.chainKey),
    rpcUrl: process.env.SOURCE_CHAIN_RPC_URL,
    emitter: process.env.SOURCE_REGISTRY_ADDRESS
  };

  const price: WatchedChain = {
    role: "price",
    name: priceChain.name,
    chainKey: environment.goldFeed.chainKey,
    rpcUrl: process.env.PRICE_CHAIN_RPC_URL,
    emitter: process.env.GOLD_AGGREGATOR_ADDRESS ?? environment.goldFeed.aggregator
  };

  const workerPrivateKey = process.env.PROOF_WORKER_PRIVATE_KEY;
  const proving = Boolean(workerPrivateKey && collateral.rpcUrl && collateral.emitter && process.env.ASC_REPO_DESK_ADDRESS);

  return {
    mode: proving ? "proving" : "read-only",
    port: Number(process.env.PORT ?? 3000),
    environment,
    collateral,
    price,
    deskAddress: process.env.ASC_REPO_DESK_ADDRESS,
    workerPrivateKey,
    workerFromBlock: process.env.WORKER_FROM_BLOCK ? Number(process.env.WORKER_FROM_BLOCK) : undefined,
    priceFromBlock: process.env.PRICE_FROM_BLOCK ? Number(process.env.PRICE_FROM_BLOCK) : undefined
  };
}
