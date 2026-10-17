import {
  ProviderError,
  type AIProvider,
  type FinishReason,
  type ModelInfo,
  type NormalizedChatRequest,
  type ProviderEvent,
  type ProviderHealth,
  type TokenCounts,
  type UsageInfo,
} from "../types/provider";
import type { AntigravityAccountStatus, CredentialStore } from "../types/admin";
import type { AntigravityCredentials } from "../types/config";
import { TokenManager } from "./token-manager";
import { parseSseStream } from "./sse";

const DEFAULT_ANTIGRAVITY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";

/**
 * The single model this gateway serves. Every chat request is routed to it
 * regardless of the model name the client requests — this is a personal
 * single-model proxy. Live-verified against the real Antigravity backend
 * on 2026-10-17 (non-stream + SSE streaming).
 */
export const ANTIGRAVITY_SERVED_MODEL = "gemini-3.8-flash-high";

/**
 * Wire SKU for the served model, discovered via
 * POST /v1internal:fetchAvailableModels against the real backend
 * (2026-10-17): the account exposes one tiered 3.8 SKU and the thinking
 * level selects the tier — "HIGH" is the high-effort route. The public
 * label stays gemini-3.8-flash-high for clients.
 */
export const ANTIGRAVITY_WIRE_MODEL = "gemini-3.8-flash-tiered";

/**
 * Static model listing exposed via GET /v1/models (single entry). Context
 * window / output limits are informational, derived from the Gemini flash
 * family.
 */
export const ANTIGRAVITY_STATIC_MODELS: ModelInfo[] = [
  {
    id: ANTIGRAVITY_SERVED_MODEL,
    object: "model",
    created: 1720000000,
    owned_by: "google-antigravity",
    contextWindow: 1048576,
    maxOutputTokens: 8192,
  },
];

export interface AntigravityProviderOptions {
  credentials?: AntigravityCredentials;
  credentialStore?: CredentialStore;
  tokenEndpoint?: string;
  fetch?: typeof fetch;
}

export class AntigravityProvider implements AIProvider {
  readonly id = "antigravity";

  private tokenManager: TokenManager;
  private endpoint: string;
  private fetchImpl: typeof fetch;
  private usage: UsageInfo = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    requests: 0,
    byModel: {},
  };

  constructor(
    credentials: AntigravityCredentials = {},
    options: {
      fetch?: typeof fetch;
      credentialStore?: CredentialStore;
      tokenEndpoint?: string;
    } = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.endpoint = (credentials.endpoint || DEFAULT_ANTIGRAVITY_ENDPOINT).replace(/\/+$/, "");
    this.tokenManager = new TokenManager({
      credentials,
      credentialStore: options.credentialStore,
      tokenEndpoint: options.tokenEndpoint,
      fetch: this.fetchImpl,
    });
  }

  getTokenManager(): TokenManager {
    return this.tokenManager;
  }

  async getAccountStatus(): Promise<AntigravityAccountStatus> {
    return this.tokenManager.getStatus();
  }

  async listModels(): Promise<ModelInfo[]> {
    return [...ANTIGRAVITY_STATIC_MODELS];
  }

  async *chat(request: NormalizedChatRequest): AsyncIterable<ProviderEvent> {
    if (request.signal?.aborted) {
      throw new ProviderError({
        code: "aborted",
        message: "Request was aborted before execution.",
      });
    }

    // Fail fast when reconnect is required
    if (this.tokenManager.isNeedsReconnect()) {
      throw new ProviderError({
        code: "unauthorized",
        message:
          "Antigravity credentials expired or revoked. Reconnect in the admin dashboard (/admin).",
        status: 401,
      });
    }

    // Single-model gateway: every request is routed to the served model,
    // regardless of the model name the client requested.
    const effectiveModel = ANTIGRAVITY_SERVED_MODEL;

    // Step 1: Resolve access token
    let accessToken = await this.tokenManager.getAccessToken(request.signal);

    const streamUrl = `${this.endpoint}/v1internal:streamGenerateContent?alt=sse`;
    const upstreamBody = this.buildUpstreamRequest(request);

    // Step 2: Call upstream with at most one refresh retry on 401
    let response: Response;
    let didRefreshRetry = false;

    while (true) {
      if (request.signal?.aborted) {
        throw new ProviderError({
          code: "aborted",
          message: "Request was aborted.",
        });
      }

      try {
        response = await this.fetchImpl(streamUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "User-Agent": "antigravity",
          },
          body: JSON.stringify(upstreamBody),
          signal: request.signal,
        });
      } catch (err) {
        if (request.signal?.aborted) {
          throw new ProviderError({
            code: "aborted",
            message: "Request was aborted during network call.",
          });
        }
        throw new ProviderError({
          code: "upstream_error",
          message: `Network error calling Antigravity upstream: ${err instanceof Error ? err.message : "unknown"}`,
          status: 502,
        });
      }

      if (response.status === 401 && !didRefreshRetry) {
        didRefreshRetry = true;
        // Refresh token and retry request exactly once
        accessToken = await this.tokenManager.refreshAccessToken(request.signal);
        continue;
      }

      break;
    }

    if (!response.ok) {
      this.handleHttpError(response.status);
    }

    if (!response.body) {
      throw new ProviderError({
        code: "upstream_error",
        message: "Antigravity response body is empty.",
        status: 502,
      });
    }

    // Step 3: Stream parsing and yielding ProviderEvents
    let started = false;
    let finishReasonRecorded: FinishReason = "stop";
    let recordedUsage: UsageInfo | undefined;
    let promptTokens = 0;
    let completionTokens = 0;

    const streamId = `chatcmpl-${request.requestId}`;
    const created = Math.floor(Date.now() / 1000);

    const sseIterator = parseSseStream(response.body, request.signal);

    for await (const chunk of sseIterator) {
      if (request.signal?.aborted) {
        throw new ProviderError({
          code: "aborted",
          message: "Request was aborted while streaming.",
        });
      }

      if (chunk.error) {
        const errorCode = chunk.error.code ?? 500;
        const errorMsg = chunk.error.message || chunk.error.status || "Upstream stream error";
        this.handleHttpError(errorCode, errorMsg);
      }

      const resp = chunk.response;
      if (!resp) continue;

      if (!started) {
        yield {
          type: "start",
          id: resp.responseId || streamId,
          model: effectiveModel,
          created,
        };
        started = true;
      }

      for (const candidate of resp.candidates ?? []) {
        if (candidate.content?.parts) {
          for (const part of candidate.content.parts) {
            if (part.text && !part.thought) {
              yield {
                type: "delta",
                text: part.text,
              };
            }
            if (part.functionCall) {
              yield {
                type: "tool_call_delta",
                index: 0,
                id: part.functionCall.id,
                name: part.functionCall.name,
                argumentsDelta: JSON.stringify(part.functionCall.args),
              };
            }
          }
        }

        if (candidate.finishReason) {
          finishReasonRecorded = this.mapFinishReason(candidate.finishReason);
        }
      }

      if (resp.usageMetadata) {
        promptTokens = resp.usageMetadata.promptTokenCount ?? promptTokens;
        completionTokens = resp.usageMetadata.candidatesTokenCount ?? completionTokens;
        const totalTokens = resp.usageMetadata.totalTokenCount ?? (promptTokens + completionTokens);
        recordedUsage = {
          promptTokens,
          completionTokens,
          totalTokens,
        };
      }
    }

    if (!started) {
      // If stream ended without any candidate payload, ensure start was sent
      yield {
        type: "start",
        id: streamId,
        model: effectiveModel,
        created,
      };
    }

    if (!recordedUsage) {
      recordedUsage = {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      };
    }

    this.recordUsage(effectiveModel, recordedUsage.promptTokens, recordedUsage.completionTokens);

    yield {
      type: "usage",
      usage: recordedUsage,
    };

    yield {
      type: "done",
      finishReason: finishReasonRecorded,
      usage: recordedUsage,
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
      detail:
        "Antigravity provider initialized. Serves gemini-3.8-flash-high for all requests (live backend verified 2026-10-17).",
    };
  }

  private buildUpstreamRequest(request: NormalizedChatRequest): Record<string, unknown> {
    const systemMessages = request.messages.filter((m) => m.role === "system");
    const nonSystemMessages = request.messages.filter((m) => m.role !== "system");

    const contents = nonSystemMessages.map((m) => {
      const role = m.role === "assistant" ? "model" : "user";
      const parts: Array<Record<string, unknown>> = [];
      if (m.content) {
        parts.push({ text: m.content });
      }
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          let argsObj: unknown = {};
          try {
            argsObj = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments;
          } catch {
            argsObj = {};
          }
          parts.push({
            functionCall: {
              name: tc.function.name,
              args: argsObj,
              id: tc.id,
            },
          });
        }
      }
      return { role, parts };
    });

    const systemInstruction =
      systemMessages.length > 0
        ? {
            role: "user",
            parts: systemMessages.map((m) => ({ text: m.content ?? "" })),
          }
        : undefined;

    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
    if (request.topP !== undefined) generationConfig.topP = request.topP;
    if (request.maxTokens !== undefined) generationConfig.maxOutputTokens = request.maxTokens;
    // Gemini 3.x thinking routes: the "-high" wire SKU is paired with an
    // explicit thinkingLevel, mirroring OMP's google-antigravity catalog
    // (effortRouting high -> gemini-3.8-flash-high + thinkingLevel HIGH).
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingLevel: "HIGH",
    };

    const projectId = this.tokenManager.getProjectId() || "default";

    return {
      project: projectId,
      model: ANTIGRAVITY_WIRE_MODEL,
      request: {
        contents,
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
        sessionId: `session_${Date.now()}`,
        labels: {
          trajectory_id: `traj_${request.requestId}`,
          last_step_index: "1",
        },
      },
      userAgent: "antigravity",
      requestType: "agent",
      requestId: `agent/gw/${Date.now()}/${request.requestId}/1`,
    };
  }

  private handleHttpError(status: number, message?: string): never {
    const defaultMsg = message ?? `Antigravity upstream returned status ${status}.`;
    if (status === 400) {
      throw new ProviderError({
        code: "invalid_request",
        message: defaultMsg,
        status: 400,
      });
    }
    if (status === 401 || status === 403) {
      throw new ProviderError({
        code: "unauthorized",
        message: "Antigravity upstream authentication failed. Check credentials in /admin.",
        status: 502,
      });
    }
    if (status === 404) {
      throw new ProviderError({
        code: "not_found",
        message: defaultMsg,
        status: 404,
      });
    }
    if (status === 429) {
      throw new ProviderError({
        code: "rate_limited",
        message: "Antigravity upstream rate limit exceeded.",
        status: 429,
      });
    }
    if (status === 504) {
      throw new ProviderError({
        code: "timeout",
        message: "Antigravity upstream timed out.",
        status: 504,
      });
    }

    throw new ProviderError({
      code: "upstream_error",
      message: defaultMsg,
      status: 502,
    });
  }

  private mapFinishReason(reason: string): FinishReason {
    switch (reason.toUpperCase()) {
      case "STOP":
        return "stop";
      case "MAX_TOKENS":
        return "length";
      case "SAFETY":
      case "RECITATION":
      case "BLOCKLIST":
        return "content_filter";
      default:
        return "stop";
    }
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
