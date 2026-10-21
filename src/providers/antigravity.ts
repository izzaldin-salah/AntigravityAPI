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
import type { ModelOption, ModelSelection, ModelSettingsSnapshot, ModelSettingsStore } from "../types/model-settings";
import { DEFAULT_MODEL_SELECTION, modelOption, publicModel, thinkingConfig, validSelection } from "./model-policy";

const DEFAULT_ANTIGRAVITY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";

/**
 * Default public model. The admin dashboard can change the gateway-wide
 * model and thinking selection; client model names do not override it.
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
  private selection: ModelSelection = { ...DEFAULT_MODEL_SELECTION };
  private settingsStore?: ModelSettingsStore;
  private settingsLoaded?: Promise<void>;
  private settingsWrite: Promise<unknown> = Promise.resolve();
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
      modelSettingsStore?: ModelSettingsStore;
    } = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.settingsStore = options.modelSettingsStore;
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
    const settings = await this.getModelSettings();
    return [{ id: settings.publicModel, object: "model", created: 1720000000, owned_by: "google-antigravity" }];
  }

  async getModelSettings(): Promise<ModelSettingsSnapshot> {
    this.settingsLoaded ??= (async () => {
      const saved = await this.settingsStore?.load();
      if (saved) {
        if (!validSelection(saved)) throw new Error("Stored model settings are invalid.");
        this.selection = { model: saved.model, thinkingLevel: saved.thinkingLevel };
      }
    })();
    const loading = this.settingsLoaded;
    try { await loading; }
    catch (error) {
      if (this.settingsLoaded === loading) this.settingsLoaded = undefined;
      throw error;
    }
    return { ...this.selection, publicModel: publicModel(this.selection), storage: this.settingsStore?.backend ?? "memory" };
  }

  async discoverModels(): Promise<ModelOption[]> {
    const signal = AbortSignal.timeout(15000);
    let token = await this.tokenManager.getAccessToken(signal);
    const call = () => this.fetchImpl(`${this.endpoint}/v1internal:fetchAvailableModels`, {
      method: "POST", signal,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "antigravity" },
      body: JSON.stringify({ project: this.tokenManager.getProjectId() || "default" }),
    });
    let response = await call();
    if (response.status === 401) { token = await this.tokenManager.refreshAccessToken(signal); response = await call(); }
    if (!response.ok) this.handleHttpError(response.status);
    const data = await response.json() as { models?: unknown };
    if (!data?.models || typeof data.models !== "object" || Array.isArray(data.models)) {
      throw new ProviderError({ code: "upstream_error", message: "The provider returned an invalid model catalog.", status: 502 });
    }
    // Return only safe, supported metadata, never arbitrary upstream fields.
    return Object.entries(data.models).flatMap(([id, metadata]) => {
      const option = modelOption(id);
      if (!option) return [];
      const name = metadata && typeof metadata === "object" && "displayName" in metadata ? metadata.displayName : undefined;
      if (typeof name === "string" && name.length <= 120) option.name = name;
      const supportsThinking = metadata && typeof metadata === "object" && "supportsThinking" in metadata ? metadata.supportsThinking : undefined;
      if (supportsThinking === false || (id.startsWith("claude-") && !id.endsWith("-thinking") && supportsThinking !== true)) {
        option.thinkingLevels = [];
      }
      return [option];
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  async updateModelSettings(selection: ModelSelection): Promise<ModelSettingsSnapshot> {
    if (!validSelection(selection)) throw new ProviderError({ code: "invalid_request", message: "Choose a supported model and thinking level.", status: 400 });
    const next = { model: selection.model, thinkingLevel: selection.thinkingLevel };
    const update = this.settingsWrite.then(async () => {
      await this.getModelSettings();
      const available = await this.discoverModels();
      const option = available.find(model => model.id === next.model);
      if (!option || (option.thinkingLevels.length ? !option.thinkingLevels.includes(next.thinkingLevel!) : next.thinkingLevel !== null)) {
        throw new ProviderError({ code: "invalid_request", message: "This model is not available to the connected account. Reload the model list.", status: 400 });
      }
      await this.settingsStore?.save(next);
      this.selection = next;
      return this.getModelSettings();
    });
    this.settingsWrite = update.catch(() => undefined);
    return update;
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

    // Snapshot before awaiting credentials so concurrent admin changes cannot
    // mix an old public label with a new upstream model or thinking level.
    const selection = await this.getModelSettings();
    const effectiveModel = selection.publicModel;

    // Step 1: Resolve access token
    let accessToken = await this.tokenManager.getAccessToken(request.signal);

    const streamUrl = `${this.endpoint}/v1internal:streamGenerateContent?alt=sse`;
    const upstreamBody = this.buildUpstreamRequest(request, selection);

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
        "Antigravity provider initialized. Model and thinking are managed in the admin dashboard.",
    };
  }

  private buildUpstreamRequest(request: NormalizedChatRequest, selection: ModelSelection): Record<string, unknown> {
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

    const generationConfig: Record<string, unknown> = thinkingConfig(selection, request.maxTokens);
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
    if (request.topP !== undefined) generationConfig.topP = request.topP;

    const projectId = this.tokenManager.getProjectId() || "default";

    return {
      project: projectId,
      model: selection.model,
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
