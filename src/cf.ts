import type { ExecutionContext } from "hono";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { AgreementIndex, ProofLedger } from "./domain.js";
import { RepoDeskGateway } from "./gateway.js";

type Env = Record<string, string>;

let app: ReturnType<typeof createApp> | undefined;

function build(env: Env) {
  Object.assign(process.env, env);
  const config = loadConfig();
  const desk = new RepoDeskGateway(config.environment, config.deskAddress);
  return createApp(config, desk, new ProofLedger(), new AgreementIndex());
}

export default {
  fetch(request: Request, env: Env, context: ExecutionContext) {
    app ??= build(env);
    return app.fetch(request, env, context);
  }
};
