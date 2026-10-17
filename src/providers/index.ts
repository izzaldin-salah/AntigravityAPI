import type { ProviderConfig } from "../types/config";
import type { AIProvider } from "../types/provider";
import { ProviderError } from "../types/provider";
import { MockProvider } from "./mock";
import { AntigravityProvider } from "./antigravity";

export { MockProvider } from "./mock";
export { AntigravityProvider } from "./antigravity";
export { TokenManager } from "./token-manager";
export { parseSseStream } from "./sse";

export function createProviderFromConfig(config: ProviderConfig): AIProvider {
  if (config.mode === "mock") {
    return new MockProvider();
  }

  if (config.mode === "antigravity") {
    return new AntigravityProvider(config.credentials);
  }

  const unknownMode = (config as { mode?: string }).mode ?? "unknown";
  throw new ProviderError({
    code: "invalid_request",
    message: `Unsupported provider mode: '${unknownMode}'. Supported modes are 'mock' and 'antigravity'.`,
    status: 400,
  });
}
