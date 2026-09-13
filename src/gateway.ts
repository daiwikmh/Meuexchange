import { Contract, JsonRpcProvider, Interface } from "ethers";
import ascRepoDeskAbi from "../contracts/abi/ASCRepoDesk.json" with { type: "json" };
import collateralRegistryAbi from "../contracts/abi/CollateralRegistry.json" with { type: "json" };
import { statusByIndex, type GoldPricePoint, type RepoAgreement, type RepoDeskReader, type RepoStatus } from "./domain.js";
import type { CreditcoinEnvironment } from "./creditcoin.js";
import type { Listing } from "./config.js";

export const repoDeskInterface = new Interface(ascRepoDeskAbi as never);
export const collateralRegistryInterface = new Interface(collateralRegistryAbi as never);

export interface UnsignedTransaction {
  chainId: number;
  to: string;
  data: string;
  value: string;
  signer: "lender" | "borrower" | "anyone";
  description: string;
}

/**
 * Reads the ASCRepoDesk on Creditcoin and prepares unsigned calldata for a participant wallet.
 * MEU never holds a lender, borrower, or issuer key: every value-moving call is signed elsewhere.
 */
export class RepoDeskGateway implements RepoDeskReader {
  private readonly provider?: JsonRpcProvider;
  private readonly contract?: Contract;

  constructor(
    private readonly environment: CreditcoinEnvironment,
    private readonly deskAddress?: string
  ) {
    if (!deskAddress) return;
    // Batched log ranges are served as one slow unit, so each read goes out on its own request.
    this.provider = new JsonRpcProvider(environment.rpcUrl, environment.chainId, { staticNetwork: true, batchMaxCount: 1 });
    this.contract = new Contract(deskAddress, ascRepoDeskAbi as never, this.provider);
  }

  get connected() {
    return Boolean(this.contract);
  }

  get address() {
    return this.deskAddress;
  }

  /**
   * Recovers agreement ids from TermsOffered rather than a tracked set, so the desk reads the same
   * on a request-scoped runtime that keeps no memory between calls.
   */
  async recentAgreementIds(span = 40_000, window = 5_000): Promise<string[]> {
    if (!this.contract || !this.provider) return [];
    const contract = this.contract;
    const head = await this.provider.getBlockNumber();
    const ranges: Array<[number, number]> = [];
    for (let start = Math.max(0, head - span); start <= head; start += window) {
      ranges.push([start, Math.min(start + window - 1, head)]);
    }
    const batches = await Promise.all(ranges.map(([from, to]) => contract.queryFilter("TermsOffered", from, to)));
    return batches.flat().flatMap((log) => ("args" in log ? [String(log.args.getValue("agreementId"))] : []));
  }

  async readAgreement(agreementId: string): Promise<RepoAgreement | null> {
    if (!this.contract) return null;
    const raw = await this.contract.getAgreement(agreementId);
    const status = statusByIndex[Number(raw.status)];
    if (!status || status === "none") return null;

    return {
      id: agreementId,
      lender: raw.lender,
      borrowerPayout: raw.borrowerPayout,
      sourceBorrower: raw.sourceBorrower,
      collateralToken: raw.collateralToken,
      collateralAmount: raw.collateralAmount.toString(),
      principal: raw.principal.toString(),
      principalUsd: raw.principalUsd.toString(),
      requiredRepayment: raw.requiredRepayment.toString(),
      repaid: raw.repaid.toString(),
      maturityAt: new Date(Number(raw.maturity) * 1000).toISOString(),
      marginCalled: raw.marginCalled,
      status: status as RepoStatus,
      ...(await this.valuation(agreementId, raw.principalUsd))
    };
  }

  /** Mark-to-market at the last proved Chainlink round; absent while no price is proved. */
  private async valuation(agreementId: string, principalUsd: bigint) {
    if (!this.contract) return {};
    try {
      const collateralValueUsd: bigint = await this.contract.collateralValueUsd(agreementId);
      if (collateralValueUsd === 0n) return {};
      return {
        collateralValueUsd: collateralValueUsd.toString(),
        ltvBps: Number((principalUsd * 10_000n) / collateralValueUsd)
      };
    } catch {
      return {};
    }
  }

  async goldPrice(): Promise<GoldPricePoint | null> {
    if (!this.contract) return null;
    const raw = await this.contract.goldPrice();
    if (raw.answer === 0n) return null;
    const updatedAt = Number(raw.updatedAt) * 1000;
    return {
      answer: raw.answer.toString(),
      roundId: Number(raw.roundId),
      updatedAt: new Date(updatedAt).toISOString(),
      stale: Date.now() - updatedAt > this.environment.goldFeed.heartbeatSeconds * 1000
    };
  }

  async sourceRegistry() {
    if (!this.contract) return "";
    return (await this.contract.sourceRegistry()) as string;
  }

  async attestedHeight(chainKey: number) {
    if (!this.provider) return null;
    const { chainInfo } = await import("@gluwa/usc-sdk");
    const info = new chainInfo.PrecompileChainInfoProvider(this.provider as never);
    const latest = await info.getLatestAttestedHeightAndHash(chainKey);
    return Number(latest.height);
  }

  /**
   * Live state of every listed asset: proved reserves, proved price, window quote and inventory.
   * A listing whose feed has no fresh round reports a closed window rather than a stale quote.
   */
  async listings(entries: Listing[]) {
    if (!this.provider || !entries.length) return [];

    const [{ default: metalAbi }, { default: windowAbi }] = await Promise.all([
      import("../contracts/abi/ProvedMetal.json", { with: { type: "json" } }),
      import("../contracts/abi/MetalWindow.json", { with: { type: "json" } })
    ]);
    const erc20 = [
      "function balanceOf(address) view returns (uint256)",
      "function totalSupply() view returns (uint256)",
      "function decimals() view returns (uint8)"
    ];

    return Promise.all(
      entries.map(async (entry) => {
        const token = new Contract(entry.token, [...erc20, ...(metalAbi as never[])], this.provider);
        const win = new Contract(entry.window, windowAbi as never, this.provider);

        const [supply, decimals, goldInventory, usdInventory] = await Promise.all([
          token.totalSupply(),
          token.decimals(),
          token.balanceOf(entry.window),
          new Contract(process.env.TEST_USD_ADDRESS ?? entry.token, erc20, this.provider).balanceOf(entry.window)
        ]);

        const reserves = await token.provedReserves().catch(() => null);
        const quote = await win
          .quote(10n ** BigInt(decimals))
          .then(([buy, sell]: [bigint, bigint]) => ({ buy: buy.toString(), sell: sell.toString() }))
          .catch(() => null);

        return {
          ...entry,
          decimals: Number(decimals),
          totalSupply: supply.toString(),
          provedReserves: reserves ? reserves.toString() : null,
          headroom: reserves ? (reserves > supply ? reserves - supply : 0n).toString() : null,
          buyUsdPerUnit: quote?.buy ?? null,
          sellUsdPerUnit: quote?.sell ?? null,
          open: quote !== null,
          tokenInventory: goldInventory.toString(),
          usdInventory: usdInventory.toString()
        };
      })
    );
  }

  offerTerms(input: {
    agreementId: string;
    borrowerPayout: string;
    sourceBorrower: string;
    principal: bigint;
    principalUsd: bigint;
    requiredRepayment: bigint;
    maturity: number;
  }): UnsignedTransaction {
    return this.unsigned(
      "offerTerms",
      [
        input.agreementId,
        input.borrowerPayout,
        input.sourceBorrower,
        input.principal,
        input.principalUsd,
        input.requiredRepayment,
        input.maturity
      ],
      "lender",
      "Publish repo terms on Creditcoin before bullion is pledged on the collateral chain."
    );
  }

  drawPrincipal(agreementId: string, principal: bigint): UnsignedTransaction {
    return {
      ...this.unsigned(
        "drawPrincipal",
        [agreementId],
        "lender",
        "Release principal. Reverts unless the pledge is proved and the proved gold price keeps the loan inside the advance rate."
      ),
      value: `0x${principal.toString(16)}`
    };
  }

  markUndercollateralised(agreementId: string): UnsignedTransaction {
    return this.unsigned(
      "markUndercollateralised",
      [agreementId],
      "anyone",
      "Flag a funded agreement whose proved bullion value no longer covers the maintenance margin."
    );
  }

  markDefaulted(agreementId: string): UnsignedTransaction {
    return this.unsigned(
      "markDefaulted",
      [agreementId],
      "anyone",
      "Record a default from the absence of proved servicing payments at maturity."
    );
  }

  private unsigned(
    method: string,
    args: unknown[],
    signer: UnsignedTransaction["signer"],
    description: string
  ): UnsignedTransaction {
    if (!this.deskAddress) throw new Error("ASC_REPO_DESK_ADDRESS is not configured");
    return {
      chainId: this.environment.chainId,
      to: this.deskAddress,
      data: repoDeskInterface.encodeFunctionData(method, args as never),
      value: "0x0",
      signer,
      description
    };
  }
}
