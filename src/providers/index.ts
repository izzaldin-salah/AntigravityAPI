import type { CredentialStore } from "../types/admin";
import type { ProviderConfig } from "../types/config";
import type { AIProvider } from "../types/provider";
import { ProviderError } from "../types/provider";
import { MockProvider } from "./mock";
import { AntigravityProvider } from "./antigravity";

export { MockProvider } from "./mock";
export { AntigravityProvider } from "./antigravity";
export { TokenManager } from "./token-manager";
export { parseSseStream } from "./sse";
export { createOAuthService, createPkcePair, maskEmail } from "./oauth";

export function createProviderFromConfig(
  config: ProviderConfig,
  deps?: { credentialStore?: CredentialStore; tokenEndpoint?: string },
): AIProvider {
  if (config.mode === "mock") {
    return new MockProvider();
  }

  if (config.mode === "antigravity") {
    return new AntigravityProvider(config.credentials, {
      credentialStore: deps?.credentialStore,
      tokenEndpoint: deps?.tokenEndpoint,
    });
  }

  const unknownMode = (config as { mode?: string }).mode ?? "unknown";
  throw new ProviderError({
    code: "invalid_request",
    message: `Unsupported provider mode: '${unknownMode}'. Supported modes are 'mock' and 'antigravity'.`,
    status: 400,
  });
}
