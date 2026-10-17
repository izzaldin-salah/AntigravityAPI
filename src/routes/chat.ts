import type { FastifyPluginAsync } from "fastify";
import { validateAndNormalizeChatRequest } from "../api/validation";
import {
  createContentChunk,
  createFinishChunk,
  createRoleChunk,
  createToolCallChunk,
  createUsageChunk,
} from "../core/chunk-mapper";
import {
  OpenAIHttpError,
  mapProviderErrorToHttp,
} from "../core/errors";
import { generateChatCompletionId } from "../core/id";
import type { UsageTracker } from "../core/usage-tracker";
import type {
  OpenAIChatCompletionResponse,
  OpenAIToolCall,
  OpenAIUsage,
} from "../types/openai";
import type {
  AIProvider,
  FinishReason,
  NormalizedChatRequest,
  UsageInfo,
} from "../types/provider";

export interface ChatRouteOptions {
  provider: AIProvider;
  usageTracker: UsageTracker;
}

function estimateTokens(
  normalized: NormalizedChatRequest,
  generatedContent: string,
): OpenAIUsage {
  // If the provider omits usage, estimate token count using ceil(chars / 4) per contract guidelines
  const promptChars = normalized.messages.reduce(
    (acc, m) => acc + (m.content ? m.content.length : 0),
    0,
  );
  const promptTokens = Math.max(1, Math.ceil(promptChars / 4));
  const completionTokens = Math.ceil(generatedContent.length / 4);
  const totalTokens = promptTokens + completionTokens;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

export const chatRoutes: FastifyPluginAsync<ChatRouteOptions> = async (
  fastify,
  opts,
) => {
  fastify.post("/v1/chat/completions", async (req, reply) => {
    const requestId =
      typeof req.id === "string" ? req.id : `req_${generateChatCompletionId()}`;

    const abortController = new AbortController();
    const onDisconnect = () => {
      abortController.abort();
    };

    req.raw.on("close", onDisconnect);
    reply.raw.on("close", onDisconnect);
    if (req.raw.socket) {
      req.raw.socket.on("close", onDisconnect);
    }

    const cleanupListeners = () => {
      req.raw.off("close", onDisconnect);
      reply.raw.off("close", onDisconnect);
      if (req.raw.socket) {
        req.raw.socket.off("close", onDisconnect);
      }
    };

    let validated;
    try {
      validated = validateAndNormalizeChatRequest(
        req.body,
        requestId,
        abortController.signal,
      );
    } catch (err) {
      cleanupListeners();
      if (err instanceof OpenAIHttpError) {
        return reply.status(err.status).send(err.body);
      }
      const { status, body } = mapProviderErrorToHttp(err);
      return reply.status(status).send(body);
    }

    const { normalized, streamOptions } = validated;

    if (!normalized.stream) {
      try {
        let completionId = generateChatCompletionId();
        let model = normalized.model;
        let created = Math.floor(Date.now() / 1000);
        let accumulatedContent = "";
        const toolCallsMap = new Map<number, OpenAIToolCall>();
        let finishReason: FinishReason = "stop";
        let providerUsage: UsageInfo | undefined;

        for await (const event of opts.provider.chat(normalized)) {
          if (abortController.signal.aborted) {
            break;
          }

          if (event.type === "start") {
            completionId = event.id || completionId;
            model = event.model || model;
            created = event.created || created;
          } else if (event.type === "delta") {
            accumulatedContent += event.text;
          } else if (event.type === "tool_call_delta") {
            let tc = toolCallsMap.get(event.index);
            if (!tc) {
              tc = {
                id: event.id ?? `call_${generateChatCompletionId().slice(9, 17)}`,
                type: "function",
                function: {
                  name: event.name ?? "",
                  arguments: event.argumentsDelta ?? "",
                },
              };
              toolCallsMap.set(event.index, tc);
            } else {
              if (event.id) tc.id = event.id;
              if (event.name) tc.function.name = event.name;
              if (event.argumentsDelta) tc.function.arguments += event.argumentsDelta;
            }
          } else if (event.type === "usage") {
            providerUsage = event.usage;
          } else if (event.type === "done") {
            finishReason = event.finishReason === "error" ? "stop" : event.finishReason;
            if (event.usage) {
              providerUsage = event.usage;
            }
          } else if (event.type === "error") {
            const { status, body } = mapProviderErrorToHttp(event.error);
            return reply.status(status).send(body);
          }
        }

        const finalUsage: OpenAIUsage = providerUsage
          ? {
              prompt_tokens: providerUsage.promptTokens,
              completion_tokens: providerUsage.completionTokens,
              total_tokens: providerUsage.totalTokens,
            }
          : estimateTokens(normalized, accumulatedContent);

        // Record usage for every completed request
        opts.usageTracker.record(model, finalUsage);

        const toolCallsList = Array.from(toolCallsMap.entries())
          .sort(([a], [b]) => a - b)
          .map(([, tc]) => tc);

        const response: OpenAIChatCompletionResponse = {
          id: completionId,
          object: "chat.completion",
          created,
          model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: accumulatedContent.length > 0 ? accumulatedContent : null,
                tool_calls: toolCallsList.length > 0 ? toolCallsList : undefined,
              },
              finish_reason: finishReason,
            },
          ],
          usage: finalUsage,
        };

        return reply.status(200).send(response);
      } catch (err) {
        const { status, body } = mapProviderErrorToHttp(err);
        return reply.status(status).send(body);
      } finally {
        cleanupListeners();
      }
    }

    // --- Streaming (SSE) path ---
    reply.hijack();

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "x-request-id": requestId,
    });
    reply.raw.flushHeaders?.();

    const heartbeatInterval = setInterval(() => {
      if (!reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.write(": keep-alive\n\n");
      }
    }, 15000);

    const writeSseFrame = (data: unknown) => {
      if (!reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      }
    };

    let streamId = generateChatCompletionId();
    let streamModel = normalized.model;
    let streamCreated = Math.floor(Date.now() / 1000);
    let roleChunkSent = false;
    let accumulatedText = "";
    let providerUsage: UsageInfo | undefined;
    let finishReason: FinishReason = "stop";
    let completedNormally = false;

    try {
      for await (const event of opts.provider.chat(normalized)) {
        if (
          abortController.signal.aborted ||
          reply.raw.destroyed ||
          reply.raw.writableEnded
        ) {
          if (!abortController.signal.aborted) {
            abortController.abort();
          }
          break;
        }

        if (event.type === "start") {
          streamId = event.id || streamId;
          streamModel = event.model || streamModel;
          streamCreated = event.created || streamCreated;
          writeSseFrame(createRoleChunk(streamId, streamModel, streamCreated));
          roleChunkSent = true;
        } else if (event.type === "delta") {
          if (!roleChunkSent) {
            writeSseFrame(createRoleChunk(streamId, streamModel, streamCreated));
            roleChunkSent = true;
          }
          accumulatedText += event.text;
          writeSseFrame(
            createContentChunk(streamId, streamModel, streamCreated, event.text),
          );
        } else if (event.type === "tool_call_delta") {
          if (!roleChunkSent) {
            writeSseFrame(createRoleChunk(streamId, streamModel, streamCreated));
            roleChunkSent = true;
          }
          writeSseFrame(
            createToolCallChunk(
              streamId,
              streamModel,
              streamCreated,
              event.index,
              event.id,
              event.name,
              event.argumentsDelta,
            ),
          );
        } else if (event.type === "usage") {
          providerUsage = event.usage;
        } else if (event.type === "done") {
          finishReason = event.finishReason === "error" ? "stop" : event.finishReason;
          if (event.usage) {
            providerUsage = event.usage;
          }

          if (!roleChunkSent) {
            writeSseFrame(createRoleChunk(streamId, streamModel, streamCreated));
            roleChunkSent = true;
          }

          writeSseFrame(
            createFinishChunk(streamId, streamModel, streamCreated, finishReason),
          );

          if (streamOptions?.include_usage) {
            const usageData: OpenAIUsage = providerUsage
              ? {
                  prompt_tokens: providerUsage.promptTokens,
                  completion_tokens: providerUsage.completionTokens,
                  total_tokens: providerUsage.totalTokens,
                }
              : estimateTokens(normalized, accumulatedText);
            writeSseFrame(
              createUsageChunk(streamId, streamModel, streamCreated, usageData),
            );
          }

          if (!reply.raw.writableEnded && !reply.raw.destroyed) {
            reply.raw.write("data: [DONE]\n\n");
          }
          completedNormally = true;
        } else if (event.type === "error") {
          const { body } = mapProviderErrorToHttp(event.error);
          writeSseFrame(body);
          if (!reply.raw.writableEnded && !reply.raw.destroyed) {
            reply.raw.write("data: [DONE]\n\n");
          }
          break;
        }
      }
    } catch (err) {
      const { body } = mapProviderErrorToHttp(err);
      writeSseFrame(body);
      if (!reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.write("data: [DONE]\n\n");
      }
    } finally {
      clearInterval(heartbeatInterval);
      cleanupListeners();

      // Record usage for every completed or partially completed request
      if (completedNormally || accumulatedText.length > 0 || providerUsage) {
        const finalUsage: OpenAIUsage = providerUsage
          ? {
              prompt_tokens: providerUsage.promptTokens,
              completion_tokens: providerUsage.completionTokens,
              total_tokens: providerUsage.totalTokens,
            }
          : estimateTokens(normalized, accumulatedText);
        opts.usageTracker.record(streamModel, finalUsage);
      }

      if (!reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.end();
      }
    }
  });
};
