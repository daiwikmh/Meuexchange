export type EnvironmentName = "testnet" | "mainnet";

export type SourceChainRole = "collateral" | "price";

export interface SourceChain {
  name: string;
  chainKey: number;
  chainId: number;
  roles: SourceChainRole[];
}

/** The Chainlink XAU/USD aggregator this desk marks its bullion book against. */
export interface GoldFeed {
  chainKey: number;
  aggregator: string;
  proxy: string;
  description: string;
  decimals: number;
  heartbeatSeconds: number;
}

export interface CreditcoinEnvironment {
  name: EnvironmentName;
  network: string;
  chainId: number;
  rpcUrl: string;
  wsUrl: string;
  explorerUrl: string;
  currency: { symbol: string; decimals: number };
  attestcoin: {
    proofBuilderUrl: string;
    dashboardUrl: string;
    blockProverPrecompile: string;
    chainInfoPrecompile: string;
    decoderAddress: string;
  };
  sourceChains: SourceChain[];
  goldFeed: GoldFeed;
}

export const environments: Record<EnvironmentName, CreditcoinEnvironment> = {
  testnet: {
    name: "testnet",
    network: "CC3 Testnet",
    chainId: 102031,
    rpcUrl: "https://rpc.cc3-testnet.creditcoin.network",
    wsUrl: "wss://rpc.cc3-testnet.creditcoin.network",
    explorerUrl: "https://creditcoin-testnet.blockscout.com",
    currency: { symbol: "tCTC", decimals: 18 },
    attestcoin: {
      proofBuilderUrl: "https://prover.cc3-testnet.creditcoin.network",
      dashboardUrl: "https://dashboard.cc3-testnet.creditcoin.network",
      blockProverPrecompile: "0x0000000000000000000000000000000000000FD2",
      chainInfoPrecompile: "0x0000000000000000000000000000000000000fd3",
      decoderAddress: "0x731c345d79Fb8BbDC541f9DF3b6317585F849F9f"
    },
    sourceChains: [
      { name: "Ethereum Sepolia", chainKey: 1, chainId: 11155111, roles: ["collateral"] },
      { name: "Ethereum Mainnet", chainKey: 3, chainId: 1, roles: ["price"] }
    ],
    goldFeed: {
      chainKey: 3,
      aggregator: "0x0e3dd634FFbF7EA89BbDCF09Ccc463302FD5f903",
      proxy: "0x214eD9Da11D2fbe465a6fc601a91E62EbEc1a0D6",
      description: "XAU / USD",
      decimals: 8,
      heartbeatSeconds: 86_400
    }
  },
  mainnet: {
    name: "mainnet",
    network: "CC3 Mainnet",
    chainId: 102030,
    rpcUrl: "https://mainnet3.creditcoin.network",
    wsUrl: "wss://mainnet3.creditcoin.network",
    explorerUrl: "https://creditcoin.blockscout.com",
    currency: { symbol: "CTC", decimals: 18 },
    attestcoin: {
      proofBuilderUrl: "https://proofbuilder.cc3-mainnet-usc.creditcoin.network",
      dashboardUrl: "https://dashboard.cc3-mainnet-usc.creditcoin.network",
      blockProverPrecompile: "0x0000000000000000000000000000000000000FD2",
      chainInfoPrecompile: "0x0000000000000000000000000000000000000fd3",
      decoderAddress: "0x9D094C9f22B10FCf842c2fC6A0981630A4F94B5C"
    },
    sourceChains: [{ name: "Ethereum Mainnet", chainKey: 1, chainId: 1, roles: ["collateral", "price"] }],
    goldFeed: {
      chainKey: 1,
      aggregator: "0x0e3dd634FFbF7EA89BbDCF09Ccc463302FD5f903",
      proxy: "0x214eD9Da11D2fbe465a6fc601a91E62EbEc1a0D6",
      description: "XAU / USD",
      decimals: 8,
      heartbeatSeconds: 86_400
    }
  }
};

export function resolveEnvironment(name = process.env.CREDITCOIN_ENV): CreditcoinEnvironment {
  const environment = environments[(name as EnvironmentName) || "testnet"];
  if (!environment) throw new Error(`Unknown Creditcoin environment: ${name}`);
  return environment;
}

export function sourceChainByKey(environment: CreditcoinEnvironment, chainKey: number) {
  const chain = environment.sourceChains.find((item) => item.chainKey === chainKey);
  if (!chain) throw new Error(`Chain key ${chainKey} is not attested on ${environment.network}`);
  return chain;
}

export function chainsForRole(environment: CreditcoinEnvironment, role: SourceChainRole) {
  return environment.sourceChains.filter((chain) => chain.roles.includes(role));
}

export function explorerTx(environment: CreditcoinEnvironment, hash: string) {
  return `${environment.explorerUrl}/tx/${hash}`;
}
