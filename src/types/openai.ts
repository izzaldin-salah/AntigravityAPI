/**
 * OpenAI-compatible wire types (baseline freeze; owner after freeze: antigravity-api-agent).
 * Extend as needed for the API layer; keep field names OpenAI-compatible.
 */

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool" | "developer";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
  tools?: OpenAIToolDefinition[];
  tool_choice?:
    | "auto"
    | "none"
    | "required"
    | { type: "function"; function: { name: string } };
  user?: string;
  stream_options?: { include_usage?: boolean };
  /** Unsupported in the MVP; n > 1 returns 400 unsupported_parameter. */
  n?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface OpenAIErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

export interface OpenAIStreamDelta {
  role?: "assistant";
  content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }>;
}

export interface OpenAIStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: OpenAIStreamDelta;
    finish_reason: string | null;
  }>;
}

export interface OpenAIChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] };
    finish_reason: string;
  }>;
  usage: OpenAIUsage;
}

export interface OpenAIModelListResponse {
  object: "list";
  data: unknown[];
}

export interface OpenAIUsageResponse {
  object: "usage";
  data: {
    requests: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    by_model: Record<
      string,
      {
        requests: number;
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      }
    >;
    since: number;
    provider: unknown | null;
  };
}

export interface OpenAIHealthResponse {
  status: "ok" | "degraded";
  version: string;
  uptime: number;
  timestamp: string;
  provider: { mode: string };
}
