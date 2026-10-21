import type { CredentialStore } from "../types/admin";
import type { ProviderConfig } from "../types/config";
import type { AIProvider } from "../types/provider";
import { ProviderError } from "../types/provider";
import { AntigravityProvider } from "./antigravity";
import type { ModelSettingsStore } from "../types/model-settings";

export { AntigravityProvider } from "./antigravity";
export { TokenManager } from "./token-manager";
export { parseSseStream } from "./sse";
export { createOAuthService, createPkcePair, maskEmail } from "./oauth";

export function createProviderFromConfig(
  config: ProviderConfig,
  deps?: { credentialStore?: CredentialStore; tokenEndpoint?: string; modelSettingsStore?: ModelSettingsStore },
): AIProvider {
  if (config.mode === "antigravity") {
    return new AntigravityProvider(config.credentials, {
      credentialStore: deps?.credentialStore,
      tokenEndpoint: deps?.tokenEndpoint,
      modelSettingsStore: deps?.modelSettingsStore,
    });
  }

  const unknownMode = (config as { mode?: string }).mode ?? "unknown";
  throw new ProviderError({
    code: "invalid_request",
    message: `Unsupported provider mode: '${unknownMode}'. The only supported mode is 'antigravity'.`,
    status: 400,
  });
}
