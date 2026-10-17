import { OpenAIHttpError } from "../core/errors";
import type {
  ChatMessage,
  NormalizedChatRequest,
  ToolCall,
  ToolDefinition,
} from "../types/provider";

export interface ValidatedChatRequest {
  normalized: NormalizedChatRequest;
  streamOptions?: { include_usage?: boolean };
}

export function validateAndNormalizeChatRequest(
  body: unknown,
  requestId: string,
  signal?: AbortSignal,
): ValidatedChatRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new OpenAIHttpError(
      400,
      "Request body must be a JSON object",
      "invalid_request_error",
      null,
    );
  }

  const b = body as Record<string, unknown>;

  // 1. model: required non-empty string
  if (typeof b.model !== "string" || b.model.trim().length === 0) {
    throw new OpenAIHttpError(
      400,
      "The 'model' parameter is required and must be a non-empty string.",
      "invalid_request_error",
      "model",
    );
  }
  const model = b.model.trim();

  // 2. messages: required non-empty array
  if (!Array.isArray(b.messages) || b.messages.length === 0) {
    throw new OpenAIHttpError(
      400,
      "The 'messages' parameter is required and must be a non-empty array.",
      "invalid_request_error",
      "messages",
    );
  }

  const allowedRoles = new Set([
    "system",
    "user",
    "assistant",
    "tool",
    "developer",
  ]);

  const messages: ChatMessage[] = [];
  for (let i = 0; i < b.messages.length; i++) {
    const msg = b.messages[i];
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      throw new OpenAIHttpError(
        400,
        `Message at index ${i} must be an object.`,
        "invalid_request_error",
        "messages",
      );
    }

    const m = msg as Record<string, unknown>;
    if (typeof m.role !== "string" || !allowedRoles.has(m.role)) {
      throw new OpenAIHttpError(
        400,
        `Message at index ${i} has an invalid or missing 'role'. Supported roles: system, user, assistant, tool, developer.`,
        "invalid_request_error",
        "messages",
      );
    }

    // Role mapping: developer -> system
    const rawRole = m.role as "system" | "user" | "assistant" | "tool" | "developer";
    const role: ChatMessage["role"] = rawRole === "developer" ? "system" : rawRole;

    let content: string | null = null;
    if (m.content !== undefined && m.content !== null) {
      if (typeof m.content !== "string") {
        throw new OpenAIHttpError(
          400,
          `Message content at index ${i} must be a string or null.`,
          "invalid_request_error",
          "messages",
        );
      }
      content = m.content;
    }

    const chatMsg: ChatMessage = {
      role,
      content,
    };

    if (typeof m.name === "string") {
      chatMsg.name = m.name;
    }

    if (typeof m.tool_call_id === "string") {
      chatMsg.tool_call_id = m.tool_call_id;
    }

    if (Array.isArray(m.tool_calls)) {
      const toolCalls: ToolCall[] = [];
      for (const tc of m.tool_calls) {
        if (
          tc &&
          typeof tc === "object" &&
          tc.type === "function" &&
          typeof tc.id === "string" &&
          tc.function &&
          typeof tc.function === "object" &&
          typeof tc.function.name === "string" &&
          typeof tc.function.arguments === "string"
        ) {
          toolCalls.push({
            id: tc.id,
            type: "function",
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          });
        }
      }
      chatMsg.tool_calls = toolCalls;
    }

    messages.push(chatMsg);
  }

  // 3. stream: boolean, default false
  let stream = false;
  if (b.stream !== undefined) {
    if (typeof b.stream !== "boolean") {
      throw new OpenAIHttpError(
        400,
        "The 'stream' parameter must be a boolean.",
        "invalid_request_error",
        "stream",
      );
    }
    stream = b.stream;
  }

  // 4. temperature: 0..2
  let temperature: number | undefined;
  if (b.temperature !== undefined && b.temperature !== null) {
    if (
      typeof b.temperature !== "number" ||
      Number.isNaN(b.temperature) ||
      b.temperature < 0 ||
      b.temperature > 2
    ) {
      throw new OpenAIHttpError(
        400,
        "The 'temperature' parameter must be a number between 0 and 2.",
        "invalid_request_error",
        "temperature",
      );
    }
    temperature = b.temperature;
  }

  // 5. top_p: 0..1
  let topP: number | undefined;
  if (b.top_p !== undefined && b.top_p !== null) {
    if (
      typeof b.top_p !== "number" ||
      Number.isNaN(b.top_p) ||
      b.top_p < 0 ||
      b.top_p > 1
    ) {
      throw new OpenAIHttpError(
        400,
        "The 'top_p' parameter must be a number between 0 and 1.",
        "invalid_request_error",
        "top_p",
      );
    }
    topP = b.top_p;
  }

  // 6. max_tokens vs max_completion_tokens (positive integers; max_completion_tokens wins)
  let maxTokens: number | undefined;
  if (b.max_completion_tokens !== undefined && b.max_completion_tokens !== null) {
    if (
      typeof b.max_completion_tokens !== "number" ||
      !Number.isInteger(b.max_completion_tokens) ||
      b.max_completion_tokens <= 0
    ) {
      throw new OpenAIHttpError(
        400,
        "The 'max_completion_tokens' parameter must be a positive integer.",
        "invalid_request_error",
        "max_completion_tokens",
      );
    }
    maxTokens = b.max_completion_tokens;
  } else if (b.max_tokens !== undefined && b.max_tokens !== null) {
    if (
      typeof b.max_tokens !== "number" ||
      !Number.isInteger(b.max_tokens) ||
      b.max_tokens <= 0
    ) {
      throw new OpenAIHttpError(
        400,
        "The 'max_tokens' parameter must be a positive integer.",
        "invalid_request_error",
        "max_tokens",
      );
    }
    maxTokens = b.max_tokens;
  }

  // 7. stop: string | string[] normalized to string[]
  let stop: string[] | undefined;
  if (b.stop !== undefined && b.stop !== null) {
    if (typeof b.stop === "string") {
      stop = [b.stop];
    } else if (
      Array.isArray(b.stop) &&
      b.stop.every((item) => typeof item === "string")
    ) {
      stop = [...b.stop];
    } else {
      throw new OpenAIHttpError(
        400,
        "The 'stop' parameter must be a string or an array of strings.",
        "invalid_request_error",
        "stop",
      );
    }
  }

  // 8. tools structural validation
  let tools: ToolDefinition[] | undefined;
  if (b.tools !== undefined && b.tools !== null) {
    if (!Array.isArray(b.tools)) {
      throw new OpenAIHttpError(
        400,
        "The 'tools' parameter must be an array of tool definitions.",
        "invalid_request_error",
        "tools",
      );
    }
    tools = [];
    for (let i = 0; i < b.tools.length; i++) {
      const t = b.tools[i];
      if (
        !t ||
        typeof t !== "object" ||
        t.type !== "function" ||
        !t.function ||
        typeof t.function !== "object" ||
        typeof t.function.name !== "string" ||
        t.function.name.trim().length === 0
      ) {
        throw new OpenAIHttpError(
          400,
          `Tool at index ${i} is not a valid function tool definition.`,
          "invalid_request_error",
          "tools",
        );
      }
      tools.push({
        type: "function",
        function: {
          name: t.function.name,
          description:
            typeof t.function.description === "string"
              ? t.function.description
              : undefined,
          parameters:
            t.function.parameters && typeof t.function.parameters === "object"
              ? (t.function.parameters as Record<string, unknown>)
              : undefined,
        },
      });
    }
  }

  // 9. tool_choice structural validation
  let toolChoice: NormalizedChatRequest["toolChoice"];
  if (b.tool_choice !== undefined && b.tool_choice !== null) {
    if (
      b.tool_choice === "auto" ||
      b.tool_choice === "none" ||
      b.tool_choice === "required"
    ) {
      toolChoice = b.tool_choice;
    } else if (
      typeof b.tool_choice === "object" &&
      b.tool_choice !== null &&
      (b.tool_choice as { type?: unknown }).type === "function" &&
      (b.tool_choice as { function?: { name?: unknown } }).function &&
      typeof (b.tool_choice as { function: { name: unknown } }).function.name ===
        "string"
    ) {
      toolChoice = b.tool_choice as {
        type: "function";
        function: { name: string };
      };
    } else {
      throw new OpenAIHttpError(
        400,
        "The 'tool_choice' parameter must be 'auto', 'none', 'required', or a function object.",
        "invalid_request_error",
        "tool_choice",
      );
    }
  }

  // 10. n > 1 -> 400 code unsupported_parameter
  if (b.n !== undefined && b.n !== null) {
    if (typeof b.n !== "number" || b.n > 1) {
      throw new OpenAIHttpError(
        400,
        "The 'n' parameter only supports 1.",
        "invalid_request_error",
        "n",
        "unsupported_parameter",
      );
    }
  }

  // stream_options
  let streamOptions: { include_usage?: boolean } | undefined;
  if (
    b.stream_options &&
    typeof b.stream_options === "object" &&
    !Array.isArray(b.stream_options)
  ) {
    const so = b.stream_options as Record<string, unknown>;
    if (typeof so.include_usage === "boolean") {
      streamOptions = { include_usage: so.include_usage };
    }
  }

  // user: optional string
  const user = typeof b.user === "string" ? b.user : undefined;

  const normalized: NormalizedChatRequest = {
    model,
    messages,
    stream,
    requestId,
    signal,
    temperature,
    topP,
    maxTokens,
    stop,
    tools,
    toolChoice,
    user,
  };

  return {
    normalized,
    streamOptions,
  };
}
