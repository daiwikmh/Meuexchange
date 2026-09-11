import { Contract, EventLog, JsonRpcProvider, Wallet } from "ethers";
import ascRepoDeskAbi from "../contracts/abi/ASCRepoDesk.json" with { type: "json" };
import collateralRegistryAbi from "../contracts/abi/CollateralRegistry.json" with { type: "json" };
import { repoAction, type ProofKind, type ProofLedger } from "./domain.js";
import type { CreditcoinEnvironment } from "./creditcoin.js";

const POLL_INTERVAL_MS = 5_000;
const ERROR_BACKOFF_MS = 10_000;
const MAX_LOG_BLOCK_RANGE = 50;
const ATTESTATION_POLL_MS = 15_000;
const ATTESTATION_TIMEOUT_MS = 1_200_000;
const GAS_BUFFER_PERCENT = 135n;
const PRICE_AGREEMENT_KEY = "gold-price";

/** Chainlink indexes `current` and `roundId`; `updatedAt` stays in the log data. */
const aggregatorAbi = [
  "event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)"
];

export interface ChainWatchConfig {
  role: "collateral" | "price";
  name: string;
  chainKey: number;
  rpcUrl: string;
  emitter: string;
  fromBlock?: number;
}

export interface ProofWorkerConfig {
  environment: CreditcoinEnvironment;
  deskAddress: string;
  privateKey: string;
  watches: ChainWatchConfig[];
}

interface ChainWatch extends ChainWatchConfig {
  provider: JsonRpcProvider;
  contract: Contract;
  events: Array<{ event: string; kind: ProofKind }>;
  cursor: number;
}

const eventsByRole: Record<ChainWatchConfig["role"], Array<{ event: string; kind: ProofKind }>> = {
  collateral: [
    { event: "CollateralPledged", kind: "collateral_pledged" },
    { event: "ServicingPaymentMade", kind: "servicing_payment" },
    { event: "CollateralReleased", kind: "collateral_released" }
  ],
  price: [{ event: "AnswerUpdated", kind: "price_update" }]
};

/**
 * Carries facts from every attested source chain into the ASCRepoDesk on Creditcoin.
 *
 * Two chains, two roles: custody events from the collateral chain, and Chainlink XAU/USD
 * rounds from the chain that actually hosts the feed. Both take the same path — attestation,
 * inclusion proof, on-chain verification — so neither enters the desk as an assertion.
 *
 * The worker holds a key, but that key can only pay gas: `execute` is permissionless and moves
 * no value, so a compromised worker cannot draw principal or release collateral.
 */
export class ProofWorker {
  private readonly creditcoinProvider: JsonRpcProvider;
  private readonly wallet: Wallet;
  private readonly desk: Contract;
  private readonly watches: ChainWatch[];
  private running = false;

  constructor(
    private readonly config: ProofWorkerConfig,
    private readonly ledger: ProofLedger
  ) {
    this.creditcoinProvider = new JsonRpcProvider(config.environment.rpcUrl, config.environment.chainId, {
      staticNetwork: true
    });
    this.wallet = new Wallet(config.privateKey, this.creditcoinProvider);
    this.desk = new Contract(config.deskAddress, ascRepoDeskAbi as never, this.wallet);

    this.watches = config.watches.map((watch) => {
      const provider = new JsonRpcProvider(watch.rpcUrl);
      const abi = watch.role === "collateral" ? (collateralRegistryAbi as never) : aggregatorAbi;
      return {
        ...watch,
        provider,
        contract: new Contract(watch.emitter, abi, provider),
        events: eventsByRole[watch.role],
        cursor: watch.fromBlock ?? 0
      };
    });
  }

  get submitter() {
    return this.wallet.address;
  }

  stop() {
    this.running = false;
  }

  async start() {
    this.running = true;
    for (const watch of this.watches) {
      if (!watch.cursor) watch.cursor = await watch.provider.getBlockNumber();
      console.log(`[worker] ${watch.role} · ${watch.name} (chainKey ${watch.chainKey}) from block ${watch.cursor}`);
      console.log(`[worker]   emitter ${watch.emitter}`);
    }
    console.log(`[worker] proving into ${this.config.deskAddress} as ${this.wallet.address}`);

    while (this.running) {
      for (const watch of this.watches) {
        watch.cursor = await this.sweep(watch);
      }
      await delay(POLL_INTERVAL_MS);
    }
  }

  /** Scans one window of a source chain's blocks and proves anything new it finds. */
  private async sweep(watch: ChainWatch) {
    let head: number;
    try {
      head = await watch.provider.getBlockNumber();
    } catch (error) {
      console.error(`[worker] ${watch.name} unreachable:`, message(error));
      await delay(ERROR_BACKOFF_MS);
      return watch.cursor;
    }
    if (head < watch.cursor) return watch.cursor;

    let start = watch.cursor;
    while (start <= head) {
      const end = Math.min(start + MAX_LOG_BLOCK_RANGE - 1, head);
      try {
        for (const { event, kind } of watch.events) {
          const logs = await watch.contract.queryFilter(event, start, end);
          for (const log of logs) {
            if (log instanceof EventLog) await this.prove(watch, log, kind);
          }
        }
        start = end + 1;
      } catch (error) {
        console.error(`[worker] ${watch.name} poll failed for ${start}-${end}:`, message(error));
        await delay(ERROR_BACKOFF_MS);
        return start;
      }
    }

    return head + 1;
  }

  private async prove(watch: ChainWatch, log: EventLog, kind: ProofKind) {
    const agreementId = kind === "price_update" ? `${PRICE_AGREEMENT_KEY}:${log.topics[2]}` : log.topics[1];
    const record = this.ledger.observe({
      agreementId,
      kind,
      chainKey: watch.chainKey,
      sourceTxHash: log.transactionHash
    });
    if (record.status !== "observed") return;

    try {
      this.ledger.advance(record.id, "awaiting_attestation", { blockHeight: log.blockNumber });
      const proof = await this.buildProof(watch, log.transactionHash, log.blockNumber);

      this.ledger.advance(record.id, "proving");
      const gasLimit = await this.estimateGas(kind, proof);
      const response = await this.desk.execute(
        repoAction[kind],
        proof.chainKey,
        proof.headerNumber,
        proof.txBytes,
        proof.merkleProof.root,
        proof.merkleProof.siblings,
        proof.continuityProof.lowerEndpointDigest,
        proof.continuityProof.roots,
        { gasLimit }
      );

      this.ledger.advance(record.id, "submitted", { creditcoinTxHash: response.hash });
      console.log(`[worker] ${kind} proof submitted: ${response.hash}`);

      const receipt = await response.wait();
      this.ledger.advance(record.id, receipt?.status === 1 ? "confirmed" : "failed", {
        creditcoinTxHash: response.hash
      });
    } catch (error) {
      this.ledger.advance(record.id, "failed", { detail: message(error) });
      console.error(`[worker] ${kind} proof failed for ${log.transactionHash}:`, message(error));
    }
  }

  /** Waits for the Attestcoin attestors to cover the block, then pulls the inclusion proof. */
  private async buildProof(watch: ChainWatch, txHash: string, blockHeight: number) {
    const { proofProvider } = await import("@gluwa/usc-sdk");
    const builder = new proofProvider.service.ProofBuilder(
      watch.chainKey,
      this.config.environment.attestcoin.proofBuilderUrl
    );

    await builder.waitUntilHeightAttested(watch.chainKey, blockHeight, ATTESTATION_POLL_MS, ATTESTATION_TIMEOUT_MS);

    const result = await builder.getProof(txHash);
    const proof = "data" in result ? result.data : result;
    if (!proof) throw new Error(`Proof builder returned no proof for ${txHash}`);
    return proof as ContinuityProof;
  }

  private async estimateGas(kind: ProofKind, proof: ContinuityProof) {
    const data = this.desk.interface.encodeFunctionData("execute", [
      repoAction[kind],
      proof.chainKey,
      proof.headerNumber,
      proof.txBytes,
      proof.merkleProof.root,
      proof.merkleProof.siblings,
      proof.continuityProof.lowerEndpointDigest,
      proof.continuityProof.roots
    ]);

    try {
      const estimate = await this.creditcoinProvider.estimateGas({
        to: this.config.deskAddress,
        data,
        from: this.wallet.address
      });
      return (estimate * GAS_BUFFER_PERCENT) / 100n;
    } catch (error) {
      // pallet-evm does not always surface precompile reverts during estimation, so fall back
      // to a size-derived limit rather than abandoning a proof that would succeed.
      const continuityBlocks = proof.continuityProof.roots?.length || 1;
      console.warn(`[worker] gas estimation failed (${message(error)}); using size-derived limit`);
      return BigInt(21_000 + continuityBlocks * 5_000 + 20_000);
    }
  }
}

interface ContinuityProof {
  chainKey: number;
  headerNumber: number;
  txBytes: string;
  merkleProof: { root: string; siblings: Array<{ hash: string; isLeft: boolean }> };
  continuityProof: { lowerEndpointDigest: string; roots: string[] };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
