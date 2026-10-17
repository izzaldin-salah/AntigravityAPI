import type {
  OpenAIStreamChunk,
  OpenAIUsage,
} from "../types/openai";
import type { FinishReason } from "../types/provider";

export function createRoleChunk(
  id: string,
  model: string,
  created: number,
): OpenAIStreamChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: { role: "assistant" },
        finish_reason: null,
      },
    ],
  };
}

export function createContentChunk(
  id: string,
  model: string,
  created: number,
  content: string,
): OpenAIStreamChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: { content },
        finish_reason: null,
      },
    ],
  };
}

export function createToolCallChunk(
  id: string,
  model: string,
  created: number,
  index: number,
  toolCallId?: string,
  name?: string,
  argumentsDelta?: string,
): OpenAIStreamChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              id: toolCallId,
              type: "function",
              function: {
                name,
                arguments: argumentsDelta,
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
}

export function createFinishChunk(
  id: string,
  model: string,
  created: number,
  finishReason: FinishReason,
): OpenAIStreamChunk {
  // §8: map "error" -> "stop"
  const normalizedFinishReason = finishReason === "error" ? "stop" : finishReason;
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: normalizedFinishReason,
      },
    ],
  };
}

export interface OpenAIStreamUsageChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: [];
  usage: OpenAIUsage;
}

export function createUsageChunk(
  id: string,
  model: string,
  created: number,
  usage: OpenAIUsage,
): OpenAIStreamUsageChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [],
    usage,
  };
}
