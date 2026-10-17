/**
 * STUB — owner: antigravity-provider-agent.
 * Replace with the provider registry described in docs/architecture-contract.md (§9):
 * mode "mock" -> deterministic offline MockProvider;
 * mode "antigravity" -> AntigravityProvider (OMP-inspired; live path UNVERIFIED).
 */
import type { ProviderConfig } from "../types/config";
import type {
  AIProvider,
  ModelInfo,
  NormalizedChatRequest,
  ProviderEvent,
  UsageInfo,
} from "../types/provider";

export class NullProvider implements AIProvider {
  readonly id = "null";

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  async *chat(_request: NormalizedChatRequest): AsyncIterable<ProviderEvent> {
    yield {
      type: "error",
      error: {
        code: "not_implemented",
        message: "Provider not implemented yet (scaffold stub).",
        status: 503,
      },
    };
  }

  async getUsage(): Promise<UsageInfo> {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
}

export function createProviderFromConfig(_config: ProviderConfig): AIProvider {
  return new NullProvider();
}
