import assert from "node:assert/strict";
import test from "node:test";
import {
  AgreementIndex,
  ProofLedger,
  repoAction,
  requireAddress,
  requireAgreementId,
  requireFutureUnix
} from "../src/domain.js";
import { RepoDeskGateway } from "../src/gateway.js";
import { createApp } from "../src/app.js";
import { chainsForRole, environments } from "../src/creditcoin.js";
import { buildWorkerConfig } from "../src/worker-setup.js";
import type { AppConfig } from "../src/config.js";

const deskAddress = "0x1111111111111111111111111111111111111111";
const registryAddress = "0x4444444444444444444444444444444444444444";
const agreementId = `0x${"ab".repeat(32)}`;
const testnet = environments.testnet;

const config: AppConfig = {
  mode: "read-only",
  port: 0,
  environment: testnet,
  collateral: { role: "collateral", name: "Ethereum Sepolia", chainKey: 1, emitter: registryAddress },
  price: { role: "price", name: "Ethereum Mainnet", chainKey: 3, emitter: testnet.goldFeed.aggregator },
  reserves: { role: "reserves", name: "Ethereum Mainnet", chainKey: 3, emitter: testnet.reserveFeed.aggregator },
  deskAddress,
  listedFeeds: [],
  listings: []
};

function harness() {
  const ledger = new ProofLedger();
  const index = new AgreementIndex();
  const desk = new RepoDeskGateway(testnet, deskAddress);
  return { ledger, index, app: createApp(config, desk, ledger, index) };
}

function terms(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    agreementId,
    borrowerPayout: "0x2222222222222222222222222222222222222222",
    sourceBorrower: "0x3333333333333333333333333333333333333333",
    principal: "40000000000000000000",
    principalUsd: "2000000000000",
    requiredRepayment: "5000000000000000000",
    maturity: Math.floor(Date.now() / 1000) + 86_400,
    ...overrides
  });
}

test("testnet carries the Attestcoin precompile and the Creditcoin chain id", () => {
  assert.equal(testnet.chainId, 102031);
  assert.equal(testnet.attestcoin.blockProverPrecompile, "0x0000000000000000000000000000000000000FD2");
});

test("collateral and gold price come from two different attested chains", () => {
  assert.equal(chainsForRole(testnet, "collateral")[0].chainKey, 1);
  assert.equal(chainsForRole(testnet, "collateral")[0].chainId, 11155111);
  assert.equal(testnet.goldFeed.chainKey, 3);
  assert.notEqual(chainsForRole(testnet, "collateral")[0].chainKey, testnet.goldFeed.chainKey);
});

test("the gold feed points at the aggregator, not the proxy", () => {
  // The EACAggregatorProxy does not emit AnswerUpdated; only the aggregator behind it does.
  assert.equal(testnet.goldFeed.aggregator, "0x0e3dd634FFbF7EA89BbDCF09Ccc463302FD5f903");
  assert.equal(testnet.goldFeed.proxy, "0x214eD9Da11D2fbe465a6fc601a91E62EbEc1a0D6");
  assert.notEqual(testnet.goldFeed.aggregator, testnet.goldFeed.proxy);
  assert.equal(testnet.goldFeed.decimals, 8);
});

test("each proof kind maps to its target contract's action", () => {
  assert.deepEqual(repoAction, {
    collateral_pledged: 0,
    servicing_payment: 1,
    collateral_released: 2,
    price_update: 3,
    reserve_update: 0
  });
  // reserve_update shares action 0 with collateral_pledged, but lands on ProvedGold rather
  // than the desk, so the collision is only apparent -- the watch's target disambiguates it.
  assert.equal(repoAction.reserve_update, 0);
});

test("the worker watches every configured chain and routes each to its own contract", () => {
  const goldAddress = "0x5555555555555555555555555555555555555555";
  const built = buildWorkerConfig({
    ...config,
    goldAddress,
    collateral: { ...config.collateral, rpcUrl: "https://sepolia.example" },
    price: { ...config.price, rpcUrl: "https://mainnet.example" },
    reserves: { ...config.reserves, rpcUrl: "https://mainnet.example" },
    workerPrivateKey: `0x${"11".repeat(32)}`
  });

  assert.deepEqual(built?.watches.map((watch) => watch.role), ["collateral", "price", "reserves"]);
  assert.equal(built?.watches[1].emitter, testnet.goldFeed.aggregator);
  assert.equal(built?.watches[1].target, deskAddress);
  assert.equal(built?.watches[2].emitter, testnet.reserveFeed.aggregator);
  assert.equal(built?.watches[2].target, goldAddress, "reserve proofs must drive the gold token");
});

test("the ASCBase execute fragment names its tuple components", async () => {
  // The proof builder returns siblings as {hash, isLeft} objects. ethers can only encode those
  // against named tuple components, so a hand-written signature silently breaks submission.
  const { default: abi } = await import("../contracts/abi/ProvedGold.json", { with: { type: "json" } });
  const execute = (abi as Array<{ name?: string; type: string; inputs?: Array<{ name: string; components?: Array<{ name: string }> }> }>)
    .find((fragment) => fragment.type === "function" && fragment.name === "execute");
  const siblings = execute?.inputs?.find((input) => input.name === "siblings");

  assert.deepEqual(siblings?.components?.map((component) => component.name), ["hash", "isLeft"]);
});

test("a listed asset adds a watch without new code", () => {
  const oracle = "0x7777777777777777777777777777777777777777";
  const built = buildWorkerConfig({
    ...config,
    collateral: { ...config.collateral, rpcUrl: "https://sepolia.example" },
    price: { ...config.price, rpcUrl: "https://mainnet.example" },
    workerPrivateKey: `0x${"11".repeat(32)}`,
    listedFeeds: [
      { name: "XAG / USD", aggregator: "0xB38d1D12Ba17aA62255e588a0bC845c1a589A50d", target: oracle, fromBlock: 25_956_688 }
    ]
  });

  const listed = built?.watches.find((watch) => watch.name === "XAG / USD");
  assert.equal(listed?.target, oracle, "a listed feed routes to its own consuming contract");
  assert.equal(listed?.chainKey, 3, "listed feeds ride the attested mainnet watch");
  assert.equal(listed?.fromBlock, 25_956_688);
});

test("the reserve feed is a different aggregator from the price feed", () => {
  assert.notEqual(testnet.reserveFeed.aggregator, testnet.goldFeed.aggregator);
  assert.equal(testnet.reserveFeed.description, "KAU Reserves");
  assert.equal(testnet.reserveFeed.decimals, 18);
  assert.notEqual(testnet.reserveFeed.aggregator, testnet.reserveFeed.proxy);
});

test("the worker skips a chain whose RPC is missing", () => {
  const built = buildWorkerConfig({
    ...config,
    collateral: { ...config.collateral, rpcUrl: "https://sepolia.example" },
    workerPrivateKey: `0x${"11".repeat(32)}`
  });

  assert.equal(built?.watches.length, 1);
  assert.equal(built?.watches[0].role, "collateral");
});

test("a source-chain event is only queued once per proof kind", () => {
  const ledger = new ProofLedger();
  const input = { agreementId, kind: "collateral_pledged" as const, chainKey: 1, sourceTxHash: "0xFEED" };

  assert.equal(ledger.observe(input).id, ledger.observe({ ...input, sourceTxHash: "0xfeed" }).id);
  assert.equal(ledger.all().length, 1);
});

test("proof records advance to confirmed and leave the pending queue", () => {
  const ledger = new ProofLedger();
  const record = ledger.observe({ agreementId, kind: "price_update", chainKey: 3, sourceTxHash: "0x01" });

  ledger.advance(record.id, "proving", { blockHeight: 25_955_885 });
  ledger.advance(record.id, "confirmed", { creditcoinTxHash: "0x02" });

  assert.equal(ledger.all()[0].status, "confirmed");
  assert.equal(ledger.all()[0].blockHeight, 25_955_885);
  assert.equal(ledger.pending().length, 0);
});

test("input guards reject malformed identifiers", () => {
  assert.throws(() => requireAgreementId("0x1234"), /32-byte hex/);
  assert.throws(() => requireAddress("nope", "lender"), /20-byte hex/);
  assert.throws(() => requireFutureUnix(1), /future unix timestamp/);
});

test("health reports the Creditcoin network without a listener", async () => {
  const response = await harness().app.request("/health");
  assert.deepEqual(await response.json(), { status: "ok", mode: "read-only", network: "CC3 Testnet" });
});

test("offering terms returns unsigned lender calldata carrying the USD credit line", async () => {
  const { app, index } = harness();
  const response = await app.request("/api/agreements/terms", { method: "POST", body: terms() });

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.transaction.to, deskAddress);
  assert.equal(body.transaction.chainId, 102031);
  assert.equal(body.transaction.signer, "lender");
  assert.equal(index.all().length, 1);
});

test("terms without a USD credit line are rejected", async () => {
  const response = await harness().app.request("/api/agreements/terms", {
    method: "POST",
    body: terms({ principalUsd: "0" })
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /principalUsd/);
});

test("a margin call is unsigned calldata anyone may send", async () => {
  const response = await harness().app.request(`/api/agreements/${agreementId}/margin-call`, { method: "POST" });
  const body = await response.json();

  assert.equal(body.transaction.signer, "anyone");
  assert.match(body.transaction.description, /maintenance margin/);
});

test("the environment route publishes both chains and the gold feed", async () => {
  const body = await (await harness().app.request("/api/environment")).json();

  assert.equal(body.attestcoin.proofBuilderUrl, "https://prover.cc3-testnet.creditcoin.network");
  assert.deepEqual(body.sourceChains.map((chain: { role: string }) => chain.role), ["collateral", "price"]);
  assert.equal(body.goldFeed.description, "XAU / USD");
  assert.equal(body.contracts.ascRepoDesk, deskAddress);
});
