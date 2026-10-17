import type {
  AIProvider,
  ModelInfo,
  NormalizedChatRequest,
  ProviderEvent,
  UsageInfo,
} from "../../src/types/provider";

export interface MockProviderOptions {
  id?: string;
  models?: ModelInfo[];
  chatHandler?: (request: NormalizedChatRequest) => AsyncIterable<ProviderEvent>;
  usage?: UsageInfo;
}

export class MockTestProvider implements AIProvider {
  readonly id: string;
  public models: ModelInfo[];
  public usage: UsageInfo;
  public chatHandler?: (
    request: NormalizedChatRequest,
  ) => AsyncIterable<ProviderEvent>;

  public listModelsCalls = 0;
  public chatCalls = 0;
  public getUsageCalls = 0;
  public healthCheckCalls = 0;
  public lastChatRequest?: NormalizedChatRequest;

  constructor(options: MockProviderOptions = {}) {
    this.id = options.id ?? "mock-test-provider";
    this.models = options.models ?? [
      {
        id: "mock-model-1",
        object: "model",
        created: 1700000000,
        owned_by: "personal-antigravity",
      },
    ];
    this.usage = options.usage ?? {
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    };
    this.chatHandler = options.chatHandler;
  }

  async listModels(): Promise<ModelInfo[]> {
    this.listModelsCalls++;
    return this.models;
  }

  async *chat(request: NormalizedChatRequest): AsyncIterable<ProviderEvent> {
    this.chatCalls++;
    this.lastChatRequest = request;

    if (this.chatHandler) {
      yield* this.chatHandler(request);
      return;
    }

    // Default chat behavior: start -> delta -> usage -> done
    yield {
      type: "start",
      id: "mock-chat-1",
      model: request.model,
      created: 1700000000,
    };

    yield {
      type: "delta",
      text: "Hello from mock provider!",
    };

    yield {
      type: "usage",
      usage: {
        promptTokens: 15,
        completionTokens: 25,
        totalTokens: 40,
      },
    };

    yield {
      type: "done",
      finishReason: "stop",
    };
  }

  async getUsage(): Promise<UsageInfo> {
    this.getUsageCalls++;
    return this.usage;
  }

  async healthCheck(): Promise<{ ok: boolean }> {
    this.healthCheckCalls++;
    return { ok: true };
  }
}
