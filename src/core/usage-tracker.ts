import type { OpenAIUsage } from "../types/openai";
import type { UsageInfo } from "../types/provider";

export interface ModelUsageStats {
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface UsageSnapshot {
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  by_model: Record<string, ModelUsageStats>;
  since: number;
}

export class UsageTracker {
  private requests = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private totalTokens = 0;
  private readonly byModel: Record<string, ModelUsageStats> = {};
  public readonly since: number;

  constructor(since: number = Date.now()) {
    this.since = since;
  }

  record(
    model: string,
    usage:
      | UsageInfo
      | OpenAIUsage
      | {
          promptTokens?: number;
          completionTokens?: number;
          totalTokens?: number;
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        },
  ): void {
    const prompt =
      "promptTokens" in usage && typeof usage.promptTokens === "number"
        ? usage.promptTokens
        : "prompt_tokens" in usage && typeof usage.prompt_tokens === "number"
          ? usage.prompt_tokens
          : 0;

    const completion =
      "completionTokens" in usage && typeof usage.completionTokens === "number"
        ? usage.completionTokens
        : "completion_tokens" in usage && typeof usage.completion_tokens === "number"
          ? usage.completion_tokens
          : 0;

    const total =
      "totalTokens" in usage && typeof usage.totalTokens === "number"
        ? usage.totalTokens
        : "total_tokens" in usage && typeof usage.total_tokens === "number"
          ? usage.total_tokens
          : prompt + completion;

    this.requests += 1;
    this.promptTokens += prompt;
    this.completionTokens += completion;
    this.totalTokens += total;

    if (!this.byModel[model]) {
      this.byModel[model] = {
        requests: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      };
    }

    const modelStats = this.byModel[model];
    modelStats.requests += 1;
    modelStats.prompt_tokens += prompt;
    modelStats.completion_tokens += completion;
    modelStats.total_tokens += total;
  }

  snapshot(): UsageSnapshot {
    const byModelCopy: Record<string, ModelUsageStats> = {};
    for (const [model, stats] of Object.entries(this.byModel)) {
      byModelCopy[model] = { ...stats };
    }

    return {
      requests: this.requests,
      prompt_tokens: this.promptTokens,
      completion_tokens: this.completionTokens,
      total_tokens: this.totalTokens,
      by_model: byModelCopy,
      since: this.since,
    };
  }
}
