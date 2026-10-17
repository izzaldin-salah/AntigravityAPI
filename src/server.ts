/**
 * Composition root per docs/architecture-contract.md (§4, §15):
 * loadConfig -> createCredentialStore -> createSessionStore -> createOAuthService
 * -> createProviderFromConfig -> buildApp -> registerSecurityPlugins -> listen.
 */
import { buildApp } from "./app";
import { loadConfig } from "./config/env";
import { UsageTracker } from "./core/usage-tracker";
import { registerSecurityPlugins } from "./middleware";
import { createProviderFromConfig } from "./providers";
import { createOAuthService } from "./providers/oauth";
import { createCredentialStore } from "./security/credential-store";
import { createSessionStore } from "./security/session-store";

async function main(): Promise<void> {
  const config = loadConfig();

  const credentialStore = createCredentialStore(config.credentials);
  const sessionStore = createSessionStore();

  const clientId =
    config.provider.mode === "antigravity"
      ? config.provider.credentials.clientId
      : undefined;
  const clientSecret =
    config.provider.mode === "antigravity"
      ? config.provider.credentials.clientSecret
      : undefined;

  const oauthService = createOAuthService({
    clientId,
    clientSecret,
    scopes: config.oauth.scopes,
    authEndpoint: config.oauth.authEndpoint,
    tokenEndpoint: config.oauth.tokenEndpoint,
  });

  const provider = createProviderFromConfig(config.provider, {
    credentialStore,
    tokenEndpoint: config.oauth.tokenEndpoint,
  });

  const usageTracker = new UsageTracker();
  const app = await buildApp({
    config,
    provider,
    usageTracker,
    admin: {
      sessionStore,
      credentialStore,
      oauthService,
    },
  });

  if (
    config.admin.enabled &&
    config.credentials.backend === "file" &&
    config.nodeEnv === "production"
  ) {
    app.log.warn(
      "Admin dashboard is enabled with file credential backend in production. File storage on Render Free is ephemeral and credentials will be lost on restart; configure REDIS_URL for persistent credential storage.",
    );
  }

  await registerSecurityPlugins(app, config);
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
