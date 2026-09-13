import { Hono } from "hono";
import type { AppConfig } from "./config.js";
import type { RepoDeskGateway } from "./gateway.js";
import {
  AgreementIndex,
  ProofLedger,
  requireAddress,
  requireAgreementId,
  requireAmount,
  requireFutureUnix
} from "./domain.js";

export function createApp(config: AppConfig, desk: RepoDeskGateway, ledger: ProofLedger, index: AgreementIndex) {
  const app = new Hono();

  const chains = () => [
    { role: "collateral", name: config.collateral.name, chainKey: config.collateral.chainKey, emitter: config.collateral.emitter ?? null },
    { role: "price", name: config.price.name, chainKey: config.price.chainKey, emitter: config.price.emitter ?? null }
  ];

  const liveAgreements = async () => {
    for (const agreementId of await desk.recentAgreementIds().catch(() => [])) index.track(agreementId);
    return index.hydrate(desk);
  };

  /** Proved rounds and agreement state change per block, so no edge in front of this may hold a copy. */
  app.use("/api/*", async (context, next) => {
    await next();
    context.header("cache-control", "no-store");
  });

  app.get("/health", (context) => context.json({ status: "ok", mode: config.mode, network: config.environment.network }));

  app.get("/api/environment", (context) =>
    context.json({
      mode: config.mode,
      creditcoin: {
        network: config.environment.network,
        chainId: config.environment.chainId,
        rpcUrl: config.environment.rpcUrl,
        explorerUrl: config.environment.explorerUrl,
        currency: config.environment.currency
      },
      attestcoin: config.environment.attestcoin,
      goldFeed: config.environment.goldFeed,
      sourceChains: chains(),
      contracts: { ascRepoDesk: config.deskAddress ?? null, collateralRegistry: config.collateral.emitter ?? null }
    })
  );

  app.get("/api/dashboard", async (context) => {
    const [agreements, goldPrice] = await Promise.all([
      desk.connected ? liveAgreements() : Promise.resolve([]),
      desk.connected ? desk.goldPrice().catch(() => null) : Promise.resolve(null)
    ]);

    const attested = desk.connected
      ? await Promise.all(
          chains().map(async (chain) => ({
            ...chain,
            attestedHeight: await desk.attestedHeight(chain.chainKey).catch(() => null)
          }))
        )
      : chains().map((chain) => ({ ...chain, attestedHeight: null }));

    return context.json({
      mode: config.mode,
      custody: "non-custodial",
      creditcoin: {
        network: config.environment.network,
        chainId: config.environment.chainId,
        rpcUrl: config.environment.rpcUrl,
        explorerUrl: config.environment.explorerUrl,
        currency: config.environment.currency
      },
      attestcoin: {
        proofBuilderUrl: config.environment.attestcoin.proofBuilderUrl,
        blockProverPrecompile: config.environment.attestcoin.blockProverPrecompile,
        chains: attested
      },
      goldFeed: config.environment.goldFeed,
      goldPrice,
      listings: await desk.listings(config.listings).catch(() => []),
      contracts: {
        ascRepoDesk: config.deskAddress ?? null,
        collateralRegistry: config.collateral.emitter ?? null,
        usd: process.env.TEST_USD_ADDRESS ?? null
      },
      agreements,
      proofs: ledger.all()
    });
  });

  app.get("/api/gold-price", async (context) => {
    const price = await desk.goldPrice();
    if (!price) return context.json({ error: "No gold price has been proved on the desk yet" }, 404);
    return context.json({ feed: config.environment.goldFeed, price });
  });

  app.get("/api/agreements", async (context) => context.json({ agreements: await liveAgreements() }));

  app.get("/api/agreements/:id", async (context) => {
    try {
      const agreementId = requireAgreementId(context.req.param("id"));
      const agreement = await desk.readAgreement(agreementId);
      if (!agreement) return context.json({ error: "Agreement not found on the ASC" }, 404);
      return context.json({ agreement, proofs: ledger.forAgreement(agreementId) });
    } catch (error) {
      return context.json({ error: message(error) }, 400);
    }
  });

  app.get("/api/proofs", (context) => context.json({ proofs: ledger.all(), pending: ledger.pending().length }));

  app.post("/api/agreements/terms", async (context) => {
    try {
      const body = await context.req.json();
      const agreementId = requireAgreementId(body.agreementId);
      const transaction = desk.offerTerms({
        agreementId,
        borrowerPayout: requireAddress(body.borrowerPayout, "borrowerPayout"),
        sourceBorrower: requireAddress(body.sourceBorrower, "sourceBorrower"),
        principal: requireAmount(body.principal, "principal"),
        principalUsd: requireAmount(body.principalUsd, "principalUsd"),
        requiredRepayment: requireAmount(body.requiredRepayment, "requiredRepayment"),
        maturity: requireFutureUnix(body.maturity)
      });
      index.track(agreementId);
      return context.json({ agreementId, transaction }, 201);
    } catch (error) {
      return context.json({ error: message(error) }, 400);
    }
  });

  app.post("/api/agreements/:id/draw", async (context) => {
    try {
      const agreementId = requireAgreementId(context.req.param("id"));
      const agreement = await desk.readAgreement(agreementId);
      if (!agreement) return context.json({ error: "Agreement not found on the ASC" }, 404);
      if (agreement.status !== "collateral_locked") {
        return context.json(
          { error: `Principal is drawable only after the pledge is proved. Current status: ${agreement.status}` },
          409
        );
      }
      return context.json({
        agreementId,
        valuation: { collateralValueUsd: agreement.collateralValueUsd ?? null, ltvBps: agreement.ltvBps ?? null },
        transaction: desk.drawPrincipal(agreementId, BigInt(agreement.principal))
      });
    } catch (error) {
      return context.json({ error: message(error) }, 400);
    }
  });

  app.post("/api/agreements/:id/margin-call", async (context) => {
    try {
      const agreementId = requireAgreementId(context.req.param("id"));
      return context.json({ agreementId, transaction: desk.markUndercollateralised(agreementId) });
    } catch (error) {
      return context.json({ error: message(error) }, 400);
    }
  });

  app.post("/api/agreements/:id/default", async (context) => {
    try {
      const agreementId = requireAgreementId(context.req.param("id"));
      return context.json({ agreementId, transaction: desk.markDefaulted(agreementId) });
    } catch (error) {
      return context.json({ error: message(error) }, 400);
    }
  });

  app.post("/api/agreements/track", async (context) => {
    try {
      const body = await context.req.json();
      const agreementId = requireAgreementId(body.agreementId);
      index.track(agreementId);
      return context.json({ agreementId, tracked: index.all().length }, 201);
    } catch (error) {
      return context.json({ error: message(error) }, 400);
    }
  });

  app.notFound((context) => context.json({ error: "Route not found" }, 404));
  return app;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}
