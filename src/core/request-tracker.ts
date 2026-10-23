import { performance } from "node:perf_hooks";
import { ProviderError, type AIProvider, type NormalizedChatRequest, type ProviderEvent, type UsageInfo } from "../types/provider";

export interface RequestSummary {
  time: number;
  model: string;
  durationMs: number;
  firstOutputMs?: number;
  result: "success" | "failed" | "cancelled";
  source: "api" | "connection test";
}
export interface RequestSnapshot {
  activeRequests: number;
  failureCounts: Record<"timeout" | "protocol" | "upstream" | "limit",number>;
  latency: {windowSize: number; completion: LatencyPercentiles; firstOutput: LatencyPercentiles};
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

interface LatencyPercentiles {p50Ms:number|null;p95Ms:number|null}
function percentiles(values:number[]):LatencyPercentiles {
  values.sort((a,b)=>a-b);
  const at=(percent:number)=>values.length?values[Math.ceil(values.length*percent)-1]:null;
  return {p50Ms:at(0.5),p95Ms:at(0.95)};
}

function failureKind(error:unknown): keyof RequestSnapshot["failureCounts"] {
  if(error instanceof ProviderError) {
    if(error.payload.code==="timeout") return "timeout";
    const detail=error.payload.details as {kind?:unknown}|undefined;
    if(detail?.kind==="protocol" || detail?.kind==="limit") return detail.kind;
  }
  return "upstream";
}

/** Process-local, bounded metadata only: never retains prompts, replies, keys, or errors. */
export class RequestTracker {
  constructor(private readonly now:()=>number = ()=>performance.now()) {}
  private activeRequests=0;
  private failureCounts: RequestSnapshot["failureCounts"]={timeout:0,protocol:0,upstream:0,limit:0};
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
    const started = this.now();
    this.activeRequests++;
    const time = Date.now();
    let model = "Not resolved";
    let result: RequestSummary["result"] = "cancelled";
    let usage: UsageInfo | undefined;
    let firstOutputMs: number | undefined;
    let failedKind: keyof RequestSnapshot["failureCounts"]="upstream";
    try {
      for await (const event of events) {
        if (event.type === "start") model = event.model.slice(0, 100);
        if(firstOutputMs===undefined && ((event.type==="delta" && event.text.length>0) || (event.type==="tool_call_delta" && (event.name || event.argumentsDelta)))) firstOutputMs=Math.max(0,Math.round(this.now()-started));
        if (event.type === "usage") usage = event.usage;
        if (event.type === "done") {
          result = event.finishReason === "error" ? "failed" : "success";
          if (event.usage) usage = event.usage;
        }
        if (event.type === "error") {result = "failed";failedKind=failureKind(new ProviderError(event.error));}
        yield event;
      }
    } catch (error) {
      result = request.signal?.aborted ? "cancelled" : "failed";
      failedKind=failureKind(error);
      throw error;
    } finally {
      if (request.signal?.aborted) result = request.signal.reason instanceof ProviderError && request.signal.reason.payload.code !== "aborted" ? "failed" : "cancelled";
      if(request.signal?.aborted && result==="failed") failedKind=failureKind(request.signal.reason);
      this.activeRequests--;
      if(result==="failed") this.failureCounts[failedKind]++;
      const durationMs = Math.max(0, Math.round(this.now() - started));
      this.requests++;
      this.totalDurationMs += durationMs;
      if (result === "success") { this.succeeded++; this.lastSuccessAt = Date.now(); }
      else if (result === "failed") this.failed++;
      else this.cancelled++;
      const validCount = (value?: number) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
      this.inputTokens += validCount(usage?.promptTokens);
      this.outputTokens += validCount(usage?.completionTokens);
      this.recent.unshift({ time, model, durationMs, ...(firstOutputMs!==undefined?{firstOutputMs}:{}), result, source });
      if (this.recent.length > 50) this.recent.length = 50;
    }
  }

  snapshot(): RequestSnapshot {
    return { since: this.since, requests: this.requests, succeeded: this.succeeded, failed: this.failed, cancelled: this.cancelled,
      activeRequests:this.activeRequests,failureCounts:{...this.failureCounts},
      latency:{windowSize:50,completion:percentiles(this.recent.map(row=>row.durationMs)),firstOutput:percentiles(this.recent.flatMap(row=>row.firstOutputMs===undefined?[]:[row.firstOutputMs]))},
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
