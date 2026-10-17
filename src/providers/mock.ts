import {
  ProviderError,
  type AIProvider,
  type ModelInfo,
  type NormalizedChatRequest,
  type ProviderEvent,
  type ProviderHealth,
  type TokenCounts,
  type UsageInfo,
} from "../types/provider";

export const MOCK_MODELS: ModelInfo[] = [
  {
    id: "mock-fast",
    object: "model",
    created: 1700000000,
    owned_by: "mock",
    contextWindow: 128000,
    maxOutputTokens: 4096,
  },
  {
    id: "mock-smart",
    object: "model",
    created: 1700000000,
    owned_by: "mock",
    contextWindow: 200000,
    maxOutputTokens: 8192,
  },
];

export class MockProvider implements AIProvider {
  readonly id = "mock";

  private usage: UsageInfo = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    requests: 0,
    byModel: {},
  };

  async listModels(): Promise<ModelInfo[]> {
    return [...MOCK_MODELS];
  }

  async *chat(request: NormalizedChatRequest): AsyncIterable<ProviderEvent> {
    if (request.signal?.aborted) {
      throw new ProviderError({
        code: "aborted",
        message: "Request was aborted before execution started.",
      });
    }

    const matchedModel = MOCK_MODELS.find((m) => m.id === request.model);
    if (!matchedModel) {
      throw new ProviderError({
        code: "not_found",
        message: `Model '${request.model}' not found in mock provider.`,
        status: 404,
      });
    }

    // Deterministically derive answer from the last user message
    let lastUserContent = "";
    for (let i = request.messages.length - 1; i >= 0; i--) {
      if (request.messages[i].role === "user") {
        lastUserContent = request.messages[i].content ?? "";
        break;
      }
    }

    const responseText = `[${request.model}] Echo: ${lastUserContent}`;
    const chunks = responseText.split(" ");
    const promptTokens = Math.max(1, Math.ceil((lastUserContent.length + 10) / 4));
    const completionTokens = Math.max(1, Math.ceil(responseText.length / 4));
    const totalTokens = promptTokens + completionTokens;

    const streamId = `chatcmpl-${request.requestId}`;
    const created = Math.floor(Date.now() / 1000);

    yield {
      type: "start",
      id: streamId,
      model: request.model,
      created,
    };

    for (let i = 0; i < chunks.length; i++) {
      if (request.signal?.aborted) {
        throw new ProviderError({
          code: "aborted",
          message: "Request was aborted during streaming.",
        });
      }

      const chunk = i === chunks.length - 1 ? chunks[i] : `${chunks[i]} `;
      yield {
        type: "delta",
        text: chunk,
      };

      // Optional short pause to simulate realistic async streaming in tests when signal can abort
      if (request.signal) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    if (request.signal?.aborted) {
      throw new ProviderError({
        code: "aborted",
        message: "Request was aborted before completion.",
      });
    }

    const usageEvent: UsageInfo = {
      promptTokens,
      completionTokens,
      totalTokens,
    };

    // Update accumulated usage
    this.recordUsage(request.model, promptTokens, completionTokens);

    yield {
      type: "usage",
      usage: usageEvent,
    };

    yield {
      type: "done",
      finishReason: "stop",
      usage: usageEvent,
    };
  }

  async getUsage(): Promise<UsageInfo> {
    return {
      promptTokens: this.usage.promptTokens,
      completionTokens: this.usage.completionTokens,
      totalTokens: this.usage.totalTokens,
      requests: this.usage.requests,
      byModel: { ...this.usage.byModel },
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      ok: true,
      detail: "Mock provider is operational.",
    };
  }

  private recordUsage(model: string, promptTokens: number, completionTokens: number): void {
    const totalTokens = promptTokens + completionTokens;
    this.usage.promptTokens += promptTokens;
    this.usage.completionTokens += completionTokens;
    this.usage.totalTokens += totalTokens;
    this.usage.requests = (this.usage.requests ?? 0) + 1;

    if (!this.usage.byModel) {
      this.usage.byModel = {};
    }

    const existing: TokenCounts = this.usage.byModel[model] ?? {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      requests: 0,
    };

    this.usage.byModel[model] = {
      promptTokens: existing.promptTokens + promptTokens,
      completionTokens: existing.completionTokens + completionTokens,
      totalTokens: existing.totalTokens + totalTokens,
      requests: existing.requests + 1,
    };
  }
}
