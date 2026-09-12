export type RepoStatus = "offered" | "collateral_locked" | "funded" | "released" | "defaulted";
export type ProofKind = "collateral_pledged" | "servicing_payment" | "collateral_released" | "price_update" | "reserve_update";
export type ProofStatus = "observed" | "awaiting_attestation" | "proving" | "submitted" | "confirmed" | "failed";

/** Action discriminators. Reserve proofs target ProvedGold, where 0 is its only action. */
export const repoAction: Record<ProofKind, number> = {
  collateral_pledged: 0,
  servicing_payment: 1,
  collateral_released: 2,
  price_update: 3,
  reserve_update: 0
};

/** Index 0 is the contract's `None` sentinel: the agreement has not been offered. */
export const statusByIndex = ["none", "offered", "collateral_locked", "funded", "released", "defaulted"] as const;

export interface RepoAgreement {
  id: string;
  lender: string;
  borrowerPayout: string;
  sourceBorrower: string;
  collateralToken: string;
  collateralAmount: string;
  principal: string;
  principalUsd: string;
  requiredRepayment: string;
  repaid: string;
  maturityAt: string;
  marginCalled: boolean;
  status: RepoStatus;
  collateralValueUsd?: string;
  ltvBps?: number;
}

export interface GoldPricePoint {
  answer: string;
  roundId: number;
  updatedAt: string;
  stale: boolean;
}

export interface ProofRecord {
  id: string;
  agreementId: string;
  kind: ProofKind;
  chainKey: number;
  sourceTxHash: string;
  blockHeight?: number;
  queryId?: string;
  creditcoinTxHash?: string;
  status: ProofStatus;
  detail?: string;
  observedAt: string;
  updatedAt: string;
}

/** Read-side view of the ASCRepoDesk deployed on Creditcoin. */
export interface RepoDeskReader {
  readAgreement(agreementId: string): Promise<RepoAgreement | null>;
  sourceRegistry(): Promise<string>;
}

const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

/**
 * Mirrors the proof pipeline that carries source-chain events to the ASC.
 * Authoritative state lives in the contract; this book exists so operators can see
 * where each event is between emission on the source chain and proof on Creditcoin.
 */
export class ProofLedger {
  private readonly records = new Map<string, ProofRecord>();
  private readonly bySourceTx = new Map<string, string>();

  observe(input: { agreementId: string; kind: ProofKind; chainKey: number; sourceTxHash: string }) {
    const existing = this.bySourceTx.get(this.key(input.sourceTxHash, input.kind));
    if (existing) return this.records.get(existing)!;

    const now = new Date().toISOString();
    const record: ProofRecord = { ...input, id: id("proof"), status: "observed", observedAt: now, updatedAt: now };
    this.records.set(record.id, record);
    this.bySourceTx.set(this.key(input.sourceTxHash, input.kind), record.id);
    return record;
  }

  advance(recordId: string, status: ProofStatus, patch: Partial<ProofRecord> = {}) {
    const record = this.records.get(recordId);
    if (!record) throw new Error("Proof record not found");
    Object.assign(record, patch, { status, updatedAt: new Date().toISOString() });
    return record;
  }

  all() {
    return [...this.records.values()].sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  }

  forAgreement(agreementId: string) {
    return this.all().filter((record) => record.agreementId === agreementId);
  }

  pending() {
    return this.all().filter((record) => record.status !== "confirmed" && record.status !== "failed");
  }

  private key(sourceTxHash: string, kind: ProofKind) {
    return `${sourceTxHash.toLowerCase()}:${kind}`;
  }
}

/** Local index of agreement ids the desk has seen, so the API can list what to read back. */
export class AgreementIndex {
  private readonly ids = new Set<string>();

  track(agreementId: string) {
    this.ids.add(agreementId.toLowerCase());
    return agreementId;
  }

  all() {
    return [...this.ids];
  }

  async hydrate(reader: RepoDeskReader) {
    const agreements = await Promise.all(this.all().map((agreementId) => reader.readAgreement(agreementId)));
    return agreements.filter((agreement): agreement is RepoAgreement => agreement !== null);
  }
}

export function requireAgreementId(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("agreementId must be a 32-byte hex string");
  }
  return value;
}

export function requireAddress(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} must be a 20-byte hex address`);
  }
  return value;
}

export function requireAmount(value: unknown, name: string): bigint {
  const amount = typeof value === "bigint" ? value : BigInt(String(value ?? ""));
  if (amount <= 0n) throw new Error(`${name} must be greater than zero`);
  return amount;
}

export function requireFutureUnix(value: unknown): number {
  const maturity = Number(value);
  if (!Number.isInteger(maturity) || maturity * 1000 <= Date.now()) {
    throw new Error("maturity must be a future unix timestamp in seconds");
  }
  return maturity;
}
