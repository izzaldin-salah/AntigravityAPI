/**
 * FROZEN SHARED CONTRACT — coordinator-owned (see docs/architecture-contract.md).
 * Owner after freeze: antigravity-provider-agent (additive changes only; report in handoff).
 * Both the provider layer and the API layer compile against this file.
 */

export interface TokenCounts {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests: number;
}

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests?: number;
  byModel?: Record<string, TokenCounts>;
  /** Epoch ms window bounds for provider quota data, when known. */
  windowStart?: number;
  windowEnd?: number;
  /** Free-form provider-specific quota details (e.g. Antigravity quota info from OMP). */
  meta?: Record<string, unknown>;
}

export interface ModelInfo {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  meta?: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/**
 * An image inside a multimodal message.
 *
 * `data` holds a base64 payload (no `data:` prefix) when the client sent a
 * data URL; `url` holds an absolute http(s) URL when the client sent a
 * remote image. The upstream accepts both shapes: base64 becomes
 * `inlineData`, a remote URL becomes `fileData` — the gateway never fetches
 * a client-supplied URL itself.
 */
export interface ImagePart {
  type: "image";
  mimeType: string;
  data?: string;
  url?: string;
}

export type MessagePart = { type: "text"; text: string } | ImagePart;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** Text content of the message (text parts joined). */
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  /**
   * v1.2 additive: multimodal parts. Present when the message carried
   * non-text content (images). `content` stays the text-only view so text
   * consumers keep working.
   */
  parts?: MessagePart[];
}

/**
 * Structured output request. `json_object` asks for JSON only;
 * `json_schema` additionally pins the shape with a JSON Schema.
 */
export interface ResponseFormat {
  type: "json_object" | "json_schema";
  /** JSON Schema for `json_schema` requests. */
  schema?: Record<string, unknown>;
  /** Optional name of the schema (informational). */
  name?: string;
}

export type FinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "error";

export interface NormalizedChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  /** Correlation id injected by the API layer. */
  requestId: string;
  /** Aborted when the client disconnects or the request is cancelled. */
  signal?: AbortSignal;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  tools?: ToolDefinition[];
  toolChoice?:
    | "auto"
    | "none"
    | "required"
    | { type: "function"; function: { name: string } };
  /**
   * v1.2 additive: structured output request. Mapped to the upstream
   * `responseMimeType` / `responseSchema` generation settings.
   */
  responseFormat?: ResponseFormat;
  user?: string;
}

export interface ProviderErrorPayload {
  /**
   * Machine-readable code. Canonical values used for HTTP mapping:
   * "invalid_request" | "unauthorized" | "not_found" | "rate_limited" |
   * "timeout" | "aborted" | "upstream_error" | "not_implemented" | "unknown"
   */
  code: string;
  message: string;
  /** Suggested HTTP status (mapping table lives in the architecture contract). */
  status?: number;
  retryable?: boolean;
  details?: unknown;
}

/**
 * Stream event contract. Ordering rules:
 *  - exactly one `start` first;
 *  - then any number of `delta` / `tool_call_delta`;
 *  - optional `usage` before the terminal event;
 *  - exactly one terminal `done` or `error`; nothing after a terminal event;
 *  - safe to stop iterating early (cancellation / client disconnect).
 */
export type ProviderEvent =
  | { type: "start"; id: string; model: string; created: number }
  | { type: "delta"; text: string }
  | {
      type: "tool_call_delta";
      index: number;
      id?: string;
      name?: string;
      argumentsDelta?: string;
    }
  | { type: "usage"; usage: UsageInfo }
  | { type: "done"; finishReason: FinishReason; usage?: UsageInfo }
  | { type: "error"; error: ProviderErrorPayload };

export interface ProviderHealth {
  ok: boolean;
  detail?: string;
}

export interface AIProvider {
  readonly id: string;
  listModels(): Promise<ModelInfo[]>;
  chat(request: NormalizedChatRequest): AsyncIterable<ProviderEvent>;
  getUsage(): Promise<UsageInfo>;
  healthCheck?(): Promise<ProviderHealth>;
  /**
   * v1.1 additive: account status for the admin dashboard (never includes tokens).
   * Implemented by AntigravityProvider; optional for injected test providers.
   */
  getAccountStatus?(): Promise<import("./admin").AntigravityAccountStatus>;
  getModelSettings?(): Promise<import("./model-settings").ModelSettingsSnapshot>;
  discoverModels?(): Promise<import("./model-settings").ModelOption[]>;
  updateModelSettings?(selection: import("./model-settings").ModelSelection): Promise<import("./model-settings").ModelSettingsSnapshot>;
}

export class ProviderError extends Error {
  readonly payload: ProviderErrorPayload;
  constructor(payload: ProviderErrorPayload) {
    super(payload.message);
    this.name = "ProviderError";
    this.payload = payload;
  }
}
