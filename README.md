# MEU Exchange — gold-backed credit on Creditcoin

MEU Exchange lends on Creditcoin against allocated gold that stays on the chain it already lives
on. Two facts the Creditcoin contract cannot see for itself — *the bullion is escrowed* and *gold
is worth this much* — both arrive as Attestcoin proofs it verifies inside the same transaction it
acts on. No oracle operator, no bridge custodian, no off-chain attestation of either fact.

- **Track:** RWA
- **Creditcoin:** CC3 Testnet, chain `102031`
- **Two attested source chains, two roles:**
  - **chain key `1`** — Ethereum Sepolia: the bullion escrow (`CollateralRegistry`)
  - **chain key `3`** — Ethereum Mainnet: the live Chainlink XAU/USD aggregator
- **Attestcoin integration:** `ASCRepoDesk` extends `ASCBase` and verifies inclusion + continuity
  proofs synchronously through the block-prover precompile at `0x…0FD2`.

## The gold price is proved, not relayed

Most cross-chain lending desks solve pricing by running an oracle operator who *writes* a price
onto the lending chain. That operator is the trust assumption. Here the desk instead proves
Chainlink's own `AnswerUpdated` event from Ethereum, where the feed actually lives:

| | Value |
|---|---|
| Feed | `XAU / USD`, 8 decimals |
| Proxy (reads) | `0x214eD9Da11D2fbe465a6fc601a91E62EbEc1a0D6` |
| **Aggregator (emits)** | `0x0e3dd634FFbF7EA89BbDCF09Ccc463302FD5f903` |
| Event topic0 | `0x0559884f…fc5f` |
| Log shape | 3 topics `[sig, answer, roundId]`, data = `updatedAt` |

The aggregator, not the proxy, is what the desk binds to: `EACAggregatorProxy` never emits
`AnswerUpdated`. Rounds must move strictly forward, so a replayed proof — still a *valid* proof —
cannot rewind the book.

## Why this needs the Attestcoin Protocol

A repo desk on Creditcoin has to answer three questions about a chain it cannot see:

| Question | Usual answer | Here |
|---|---|---|
| Was the bullion escrowed? | An oracle operator says so | A proved `CollateralPledged` event |
| What is gold worth? | A relayed price feed | A proved Chainlink `AnswerUpdated` round |
| Was the servicing paid? | A servicer's report | A proved `ServicingPaymentMade` event |
| Is the loan undercollateralised? | A risk desk asserts it | Proved spot below the maintenance margin |
| Is the borrower in default? | A risk desk asserts it | Maturity passes with repayment **unproved** |

The third is the interesting one. Because every payment that exists carries a proof, an unproved
balance at maturity is a real shortfall — so `markDefaulted` is permissionless and needs no
operator. The protocol's continuity proof is what makes absence meaningful: the desk knows it has
seen a continuous, attested view of the source chain, not a sampled one.

## Architecture

```
Ethereum Sepolia  (key 1)           off-chain                         Creditcoin
─────────────────────────           ─────────                         ──────────
CollateralRegistry  ──event──▶                                    ASCRepoDesk (ASCBase)
  pledge()                        ProofWorker                        execute(action, proof…)
  recordPayment()                   1. observe event                   ├─ block prover 0x…0FD2
  release()                         2. wait for attestation            ├─ dedupe by queryId
                                    3. ProofBuilder.getProof()         └─ _processAndEmitEvent
Ethereum Mainnet  (key 3)           4. submit execute()                     ↓
─────────────────────────                                          offered → collateral_locked
Chainlink XAU/USD   ──event──▶                                     → funded → released
  AnswerUpdated()                                                           ↘ defaulted
                                                                   + permissionless margin call
```

One worker, one desk, two `ProofBuilder` instances — one per chain key. Each chain keeps its own
block cursor, because Sepolia and mainnet advance and attest at different rates.

The source-chain contract is deliberately minimal — escrow plus three unambiguous events — as the
Attestcoin dApp design guidance recommends. All business logic lives in the ASC on Creditcoin.

### Key custody

MEU holds no participant key. The API only *reads* Creditcoin and returns unsigned calldata for a
wallet to sign. The one key in the system belongs to the proof worker, and it can only pay gas:
`execute` is permissionless and moves no value, so a compromised worker cannot draw principal or
release collateral. It can only tell the desk something the source chain already proved.

## Proved on testnet

Every transaction below is live on CC3 Testnet. The sequence is the whole argument:
the desk refuses credit while it has no proof, and grants it once the proof arrives — same
call, same arguments, nothing changed but the evidence.

| Step | Result |
|---|---|
| Chainlink XAU/USD round 10212 proved from Ethereum mainnet | [`0x7dbfd096…c855d`](https://creditcoin-testnet.blockscout.com/tx/0x7dbfd096940c90833c4923a2830608289b8532483a7f3212e32fbe0950cc855d) — `GoldPriceProved(434913500000, 10212, …)` |
| `offerTerms` — $20,000 credit line against 40 tCTC | [`0x4d9014af…d9d4`](https://creditcoin-testnet.blockscout.com/tx/0x4d9014afe01bd6a279da6a034169fa8d09f5944a328067832f45f7668e0bd9d4) |
| **`drawPrincipal` before any pledge is proved** | **reverts** `UnexpectedStatus(0x87b6c05d…, 1)` — selector `0xaf4cf409`, status 1 = `Offered` |
| `pledge` 10 oz bullion on Sepolia | [`0x512319ed…f8e9`](https://sepolia.etherscan.io/tx/0x512319edc123e8b50657abb0805fe60b470da57a5ddcd3d5c65d0bf570d2f8e9) — block 11,687,111 |
| Pledge proved to Creditcoin | [`0xce551f35…1e4a`](https://creditcoin-testnet.blockscout.com/tx/0xce551f3536723aa4ef3819ab970d435f69b4ab058a16b8006a81a90529871e4a) — `CollateralProved(…, 10 oz, …)` |
| **`drawPrincipal` after the proof** | [`0xbdae44c9…7e3e`](https://creditcoin-testnet.blockscout.com/tx/0xbdae44c945e53d3817f046981f06f4679e658e1d5fdd28f5d589cf13af5b7e3e) — `PrincipalDrawn(…, 40 tCTC, 4598)` |

`4598` is the loan's LTV in basis points: **45.98%**, computed on-chain from the proved gold
price ($20,000 drawn against $43,491.35 of bullion, inside the 60% advance rate).

Both proof transactions carry two logs: one from the block-prover precompile at `0x…0FD2`, one
from the desk. That pairing is the design — the proof is verified and acted on in a single
transaction, so there is no window in which an unverified fact sits in contract storage.

### Reserve-gated issuance

`ProvedGold` is a Creditcoin-native gold token whose supply is capped by reserves the issuer does
not control. `provedReserves` only moves when a Chainlink Proof-of-Reserve round from Ethereum is
verified here by the block-prover precompile:

```solidity
issue(to, grams)  requires  totalSupply() + grams <= provedReserves
```

| Step | Result |
|---|---|
| `issue` before any reserve proof | reverts `NoReservesProved()` — the token cannot exist before a proof does |
| KAU Reserves round proved from mainnet | [`0xecd04c2c…7ef1`](https://creditcoin-testnet.blockscout.com/tx/0xecd04c2c2c64c53165cb186ed2623a36a16454f727eedece3593287565817ef1) — `ReservesProved(2567133466…, 201, …)` |
| `issue` 1,000 g | [`0xd3509d0e…7664`](https://creditcoin-testnet.blockscout.com/tx/0xd3509d0ee456b875d574f8bc49a50238902d65c6d7c9a6a6565048d386687664) |
| `issue` 1 g past headroom | reverts `ExceedsProvedReserves(2566134…, 2566133466…)` |

2,567,133.466 grams (82,535 troy oz) is the figure Chainlink's `KAU Reserves` feed actually
reports on Ethereum mainnet. Creditcoin cannot see that feed; Attestcoin proves it. The issuer
would have to compromise Chainlink's feed rather than their own contract to mint past it.

**This does not audit the vault.** It proves the feed *said* that number, and removes the relay
and the issuer's self-report from the trust path. The auditor remains trusted. The KAU feed also
attests Kinesis's vault, so the demo models an issuer whose reserves that feed reports — a
stand-in in the way `TestBullion` stands in for PAXG. In production an issuer commissions their
own PoR feed and only the bound address changes.

The token is denominated in grams to match the feed exactly, so the safety-critical cap needs no
unit arithmetic; the gram-to-troy-ounce conversion lives in the pricing path, where a rounding
error costs basis points instead of breaking the supply cap.

### Listing a second asset: silver

Listing an RWA is configuration, not new code. Silver was listed end to end against two feeds
Chainlink already operates on Ethereum, with nothing invented:

| | Feed | Value proved onto Creditcoin |
|---|---|---|
| Price | `XAG / USD` `0xB38d1D12…A50d` | $64.486 / troy oz, round 29850 |
| Reserves | `KAG Reserves` `0x3B4f49f4…AAAc` | 3,688,827.985 g of vaulted silver, round 203 |

```
issue 5,000 g pSILVER   0x0b8d7114…115b
fund the window         0xc644fc63…22b7
buy 100 g               0xbb122fab…aa5d
                        Bought(buyer, 100e18, 208363940, 29850)
```

$64.486/oz ÷ 31.1034768 g = $2.073273/gram, and the fill carries round 29850 — the same
auditable link back to a proved Chainlink round that the gold window provides.

Three generalisations made that possible:

- **`ProvedPriceOracle`** — one ASC proving any number of registered aggregators, keyed by the
  emitting aggregator. Listing a price feed is `registerAggregator(...)`, one transaction.
- **`ProvedMetal`** — name, symbol and reserve aggregator are constructor arguments, so an asset
  with a Proof-of-Reserve feed lists without new code.
- **`MetalWindow`** — the price aggregator is a constructor argument, and it reads both tokens'
  decimals rather than assuming them.

The worker reads `LISTED_FEEDS` from the environment, so adding an asset's feeds is a config
entry naming an aggregator and the contract that consumes its rounds.

**There is no CTC/USD feed on Chainlink.** Quoting in a USD token is therefore forced, not a
shortcut: no provable way to price metal in tCTC exists today.

### Deployed addresses

| Contract | Chain | Address |
|---|---|---|
| `ASCRepoDesk` | Creditcoin Testnet | `0x0231762F2F2285F6ea27Ad456E144C1371e4AF3B` |
| `CollateralRegistry` | Ethereum Sepolia | `0x3A053Dbffb16C033eF16eBcD4dE45673BE3346d4` |
| `TestBullion` (tXAU) | Ethereum Sepolia | `0x626DA908bdE6F66f9178B3128dd17D82dc74CE21` |
| `ProvedGold` (pGOLD) | Creditcoin Testnet | `0x2a8142Db4C3b90333339A6E25b225e808098BDB0` |
| `TestUSD` (tUSD) | Creditcoin Testnet | `0x63b8493f7508Bea15b5D29A369E74D99Ac8932d6` |
| `GoldWindow` | Creditcoin Testnet | `0x2369B00a916132cBD3639bB29353d062f5fF325a` |
| `ProvedPriceOracle` | Creditcoin Testnet | `0x9B6eB52D26CeF7b04bb52b307Db86262bD8D6C8A` |
| `ProvedMetal` (pSILVER) | Creditcoin Testnet | `0x74f6E83aA79a16CeD41Ec5b0697879E51e81cAd0` |
| `MetalWindow` (silver) | Creditcoin Testnet | `0x2BE77D62F16438ce44c41120846321d871b73806` |

Two Chainlink aggregators on Ethereum mainnet, proved through one protocol into two contracts:
`XAU / USD` (`0x0e3dd634…f903`) marks the repo book, `KAU Reserves` (`0x9b3a984d…d59c`) caps gold
issuance. Each watch names its own target, and since both contracts inherit `execute` from
`ASCBase`, one ABI fragment drives both.

## Setup

```bash
npm install
git clone --depth 1 https://github.com/foundry-rs/forge-std lib/forge-std
cp .env.example .env
```

Requires Node 22+ and Foundry (tested on forge 1.7.1).

```bash
npm run build:contracts   # forge build
npm run test:contracts    # 21 Solidity tests
npm test                  # 14 API/domain tests
npm run check:attestation # live attested heights for both chains
npm run check             # tsc --noEmit
```

## Deploy to testnet

Fund one account with Sepolia ETH and Creditcoin tCTC, put its key in `DEPLOYER_PRIVATE_KEY`,
set `SOURCE_CHAIN_RPC_URL` to a Sepolia RPC, then:

```bash
./scripts/deploy.sh
```

It deploys `CollateralRegistry` to Sepolia, `ASCRepoDesk` to Creditcoin, binds the desk to the
registry with `registerSourceRegistry`, and prints the two addresses for `.env`.

## Run

```bash
npm run dev        # Hono API on :3000
npm run worker     # proof worker (separate process)
npm run dev:web    # Astro landing page and /dashboard
```

Set `INLINE_WORKER=true` to run the worker inside the API process so the dashboard shows the live
proof pipeline from a single command.

## Demo runbook

1. Lender calls `offerTerms(...)` on Creditcoin with a tCTC principal and a USD credit line → `offered`.
2. The worker proves a Chainlink `AnswerUpdated` round from Ethereum mainnet → the desk has a spot price.
3. Borrower approves `TestBullion` and calls `pledge(agreementId, token, ounces, lender)` on Sepolia.
4. The worker proves `CollateralPledged` → `collateral_locked`.
5. Lender calls `drawPrincipal(agreementId)` with `msg.value == principal`.
   **Before step 4 this reverts, and before step 2 it reverts too** — those two reverts are the demo.
   It also reverts if the USD credit line exceeds the advance rate against the proved gold value.
6. Borrower calls `recordPayment` on Sepolia; proved payments accumulate in `repaid`.
7. Either `release` on Sepolia → proved → `released`; or let maturity pass and anyone calls
   `markDefaulted`; or prove a lower gold round and anyone calls `markUndercollateralised`.

### Risk parameters

`registerCollateralAsset(token, decimals, advanceRateBps, maintenanceBps)` — the demo deploys at a
60% advance rate and a 75% maintenance margin. `collateralValueUsd` refuses to value a book against
a price older than 26 hours (Chainlink's XAU/USD heartbeat is 24 hours).

## API

- `GET /health`, `GET /api/environment` — network, precompiles, proof builder, both source chains, gold feed
- `GET /api/gold-price` — the last proved Chainlink round and its staleness
- `GET /api/dashboard` — agreements with live LTV, proof pipeline, attested height per chain
- `GET /api/agreements`, `GET /api/agreements/:id`, `GET /api/proofs`
- `POST /api/agreements/terms` — unsigned lender calldata
- `POST /api/agreements/:id/draw` — refuses with `409` unless collateral is proved
- `POST /api/agreements/:id/margin-call`, `POST /api/agreements/:id/default` — unsigned permissionless calldata

## Interface

The Astro landing page and `/dashboard` carry the design system recorded in [DESIGN.md](DESIGN.md);
image provenance is in [ASSETS.md](ASSETS.md). The dashboard reads `GET /api/dashboard` and connects
a participant wallet through the MetaMask SDK. It never receives a private key.

## Known limitations

- **Read-only direction.** Attestcoin writability is still in development, so every cross-chain flow
  here is Ethereum → Creditcoin. Releasing source-chain collateral is a source-chain decision whose
  event is then proved to Creditcoin; Creditcoin never writes to Sepolia.
- **Emitter binding, not chain binding.** `ASCBase.execute` does not pass `chainKey` to
  `_processAndEmitEvent`, so the desk binds trust to the registry's address (as the reference
  examples do). A contract at the same address on another attested chain would be indistinguishable.
  Deploy the registry from a nonce that is not reproducible on the other attested chain.
- **Attestation latency.** Both chains ran ~40 blocks behind head when measured (Sepolia ~8 min,
  mainnet ~8 min), so the desk always marks to a slightly historic round.
- **The gold price is only as fresh as the last proved round.** A fast crash between rounds is not
  visible to the desk until the next `AnswerUpdated` is proved. The 26-hour staleness guard bounds
  the exposure but does not remove it.
- **Aggregator upgrades.** Chainlink can migrate a feed to a new aggregator, which would silence the
  bound emitter. `registerPriceAggregator` is set-once, so a migration needs a new desk deployment.
- **Proof decoding is not unit-tested against real RLP.** The Solidity tests exercise the log
  handlers with constructed `ReceiptFields`; the RLP decode path is exercised on testnet.
- **Run one worker.** Two instances prove the same events twice; the duplicate is rejected by
  `ASCBase` deduplication, but only after paying for a reverted transaction.
- **Watches sweep sequentially.** One watch with a large backfill range starves the others: a
  3,800-block price backfill in 50-block chunks is 76 sequential RPC calls before the reserve
  watch gets a turn. Per-watch concurrency is the fix; advancing the cursor is only a workaround.
- **Proof-pipeline state is in memory.** The ledger's dedupe does not survive a worker restart,
  so `PRICE_FROM_BLOCK` must be advanced past an already-proved round or the worker resubmits a
  proof the desk rejects as stale, wasting gas on a guaranteed revert. Persisting the ledger is
  the obvious fix and is not done here.
- `@gluwa/usc-sdk` ships CJS type declarations, so its provider parameter needs a cast at the one
  call site in `src/gateway.ts` where an ESM `JsonRpcProvider` is handed to the SDK.
