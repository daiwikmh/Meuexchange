import { Contract, JsonRpcProvider, Interface } from "ethers";
import ascRepoDeskAbi from "../contracts/abi/ASCRepoDesk.json" with { type: "json" };
import collateralRegistryAbi from "../contracts/abi/CollateralRegistry.json" with { type: "json" };
import { statusByIndex, type GoldPricePoint, type RepoAgreement, type RepoDeskReader, type RepoStatus } from "./domain.js";
import type { CreditcoinEnvironment } from "./creditcoin.js";

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
    this.provider = new JsonRpcProvider(environment.rpcUrl, environment.chainId, { staticNetwork: true });
    this.contract = new Contract(deskAddress, ascRepoDeskAbi as never, this.provider);
  }

  get connected() {
    return Boolean(this.contract);
  }

  get address() {
    return this.deskAddress;
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

  /** Live state of the dealing window, when one is configured. */
  async market() {
    const windowAddress = process.env.GOLD_WINDOW_ADDRESS;
    const usdAddress = process.env.TEST_USD_ADDRESS;
    const goldAddress = process.env.PROVED_GOLD_ADDRESS;
    if (!this.provider || !windowAddress || !usdAddress || !goldAddress) return null;

    const { default: goldWindowAbi } = await import("../contracts/abi/GoldWindow.json", { with: { type: "json" } });
    const erc20 = ["function balanceOf(address) view returns (uint256)"];
    const win = new Contract(windowAddress, goldWindowAbi as never, this.provider);
    const base = {
      window: windowAddress,
      usd: usdAddress,
      gold: goldAddress,
      goldInventory: (await new Contract(goldAddress, erc20, this.provider).balanceOf(windowAddress)).toString(),
      usdInventory: (await new Contract(usdAddress, erc20, this.provider).balanceOf(windowAddress)).toString(),
      spreadBps: Number(await win.spreadBps())
    };

    try {
      const oneGram = 10n ** 18n;
      const [buyUsd, sellUsd] = await win.quote(oneGram);
      return {
        ...base,
        midUsdPerGram: (await win.midUsdPerGram()).toString(),
        buyUsdPerGram: buyUsd.toString(),
        sellUsdPerGram: sellUsd.toString()
      };
    } catch {
      // A stale or absent proved round closes the window; inventory is still worth showing.
      return { ...base, midUsdPerGram: null, buyUsdPerGram: null, sellUsdPerGram: null };
    }
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
