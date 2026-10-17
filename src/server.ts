/**
 * SCAFFOLD PLACEHOLDER — owner: antigravity-api-agent (final integration check by coordinator).
 * Composition root per docs/architecture-contract.md (§4):
 * loadConfig -> createProviderFromConfig -> buildApp -> registerSecurityPlugins -> listen.
 */
import { buildApp } from "./app";
import { loadConfig } from "./config/env";
import { registerSecurityPlugins } from "./middleware";
import { createProviderFromConfig } from "./providers";

async function main(): Promise<void> {
  const config = loadConfig();
  const provider = createProviderFromConfig(config.provider);
  const app = await buildApp({ config, provider });
  await registerSecurityPlugins(app, config);
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
