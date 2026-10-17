import { performance } from "node:perf_hooks";
import { ProviderError, type AIProvider, type NormalizedChatRequest, type ProviderEvent, type UsageInfo } from "../types/provider";

export interface RequestSummary {
  time: number;
  model: string;
  durationMs: number;
  result: "success" | "failed" | "cancelled";
  source: "api" | "connection test";
}
export interface RequestSnapshot {
  since: number;
  requests: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  inputTokens: number;
  outputTokens: number;
  averageDurationMs: number;
  lastSuccessAt?: number;
  recent: RequestSummary[];
}

/** Process-local, bounded metadata only: never retains prompts, replies, keys, or errors. */
export class RequestTracker {
  private readonly since = Date.now();
  private requests = 0;
  private succeeded = 0;
  private failed = 0;
  private cancelled = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private totalDurationMs = 0;
  private lastSuccessAt?: number;
  private readonly recent: RequestSummary[] = [];

  async *observe(request: NormalizedChatRequest, events: AsyncIterable<ProviderEvent>, source: RequestSummary["source"]): AsyncIterable<ProviderEvent> {
    const started = performance.now();
    const time = Date.now();
    let model = "Not resolved";
    let result: RequestSummary["result"] = "cancelled";
    let usage: UsageInfo | undefined;
    try {
      for await (const event of events) {
        if (event.type === "start") model = event.model.slice(0, 100);
        if (event.type === "usage") usage = event.usage;
        if (event.type === "done") {
          result = event.finishReason === "error" ? "failed" : "success";
          if (event.usage) usage = event.usage;
        }
        if (event.type === "error") result = "failed";
        yield event;
      }
    } catch (error) {
      result = request.signal?.aborted ? "cancelled" : "failed";
      throw error;
    } finally {
      if (request.signal?.aborted) result = request.signal.reason instanceof ProviderError && request.signal.reason.payload.code === "timeout" ? "failed" : "cancelled";
      const durationMs = Math.max(0, Math.round(performance.now() - started));
      this.requests++;
      this.totalDurationMs += durationMs;
      if (result === "success") { this.succeeded++; this.lastSuccessAt = Date.now(); }
      else if (result === "failed") this.failed++;
      else this.cancelled++;
      const validCount = (value?: number) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
      this.inputTokens += validCount(usage?.promptTokens);
      this.outputTokens += validCount(usage?.completionTokens);
      this.recent.unshift({ time, model, durationMs, result, source });
      if (this.recent.length > 50) this.recent.length = 50;
    }
  }

  snapshot(): RequestSnapshot {
    return { since: this.since, requests: this.requests, succeeded: this.succeeded, failed: this.failed, cancelled: this.cancelled,
      inputTokens: this.inputTokens, outputTokens: this.outputTokens,
      averageDurationMs: this.requests ? Math.round(this.totalDurationMs / this.requests) : 0,
      lastSuccessAt: this.lastSuccessAt, recent: this.recent.map(row => ({ ...row })) };
  }
}

export function trackProvider(provider: AIProvider, tracker: RequestTracker, source: RequestSummary["source"]): AIProvider {
  return {
    id: provider.id,
    listModels: () => provider.listModels(),
    chat: request => tracker.observe(request, provider.chat(request), source),
    getUsage: () => provider.getUsage(),
    ...(provider.healthCheck ? { healthCheck: () => provider.healthCheck!() } : {}),
    ...(provider.getAccountStatus ? { getAccountStatus: () => provider.getAccountStatus!() } : {}),
  };
}
