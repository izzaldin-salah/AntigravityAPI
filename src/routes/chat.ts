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
import { createSseWriter } from "../core/sse-writer";
import { ProviderError } from "../types/provider";
import { generateChatCompletionId } from "../core/id";
import { abortable, cancellationReason, createChatDeadline, type ChatTimeouts } from "../core/chat-deadline";
import {
  createJsonFenceFilter,
  stripJsonFence,
} from "../core/json-fence";
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
  timeouts?: Partial<ChatTimeouts>;
  maxResponseBytes?: number;
}

function estimateTokens(
  normalized: NormalizedChatRequest,
  generatedChars: number,
): OpenAIUsage {
  // If the provider omits usage, estimate token count using ceil(chars / 4) per contract guidelines
  const promptChars = normalized.messages.reduce(
    (acc, m) => acc + (m.content ? m.content.length : 0),
    0,
  );
  const promptTokens = Math.max(1, Math.ceil(promptChars / 4));
  const completionTokens = Math.ceil(generatedChars / 4);
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
    let deadline: ReturnType<typeof createChatDeadline> | undefined;
    const onDisconnect = () => {
      // Only treat this as a disconnect while the response is still in flight.
      // NOTE: req.raw "close" fires when the request body has been fully consumed
      // (Node >= 16) and must NOT be used as a disconnect signal — aborting there
      // breaks every normal request. We watch the real abort/transport signals.
      if (!reply.raw.writableEnded && !abortController.signal.aborted) {
        abortController.abort();
      }
    };

    req.raw.on("aborted", onDisconnect);
    reply.raw.on("close", onDisconnect);
    if (req.raw.socket) {
      req.raw.socket.on("close", onDisconnect);
    }

    const cleanupListeners = () => {
      deadline?.dispose();
      req.raw.off("aborted", onDisconnect);
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
    deadline = createChatDeadline(abortController.signal,opts.timeouts);
    normalized.signal = deadline.signal;
    normalized.onUpstreamProgress = deadline.progress;

    let responseBytes = 0;
    const countOutput = (text: string) => {
      responseBytes += Buffer.byteLength(text);
      if(responseBytes > (opts.maxResponseBytes ?? 16*1024*1024)) {
        const error = new ProviderError({code:"upstream_error",message:"Model response exceeds the configured byte limit.",status:502,details:{kind:"limit"}});
        abortController.abort(error);
        throw error;
      }
    };
    if (!normalized.stream) {
      try {
        let completionId = generateChatCompletionId();
        let model = normalized.model;
        let created = Math.floor(Date.now() / 1000);
        let accumulatedContent = "";
        const toolCallsMap = new Map<number, OpenAIToolCall>();
        let finishReason: FinishReason = "stop";
        let receivedCompletion = false;
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
            countOutput(event.text);
            accumulatedContent += event.text;
          } else if (event.type === "tool_call_delta") {
            countOutput((event.argumentsDelta ?? "") + (event.name ?? "") + (event.id ?? ""));
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
            if (event.finishReason === "error") throw new ProviderError({code:"upstream_error",message:"Provider reported a failed completion."});
            finishReason = event.finishReason;
            receivedCompletion = true;
            if (event.usage) {
              providerUsage = event.usage;
            }
            break;
          } else if (event.type === "error") {
            const { status, body } = mapProviderErrorToHttp(event.error);
            return reply.status(status).send(body);
          }
        }

        if (!receivedCompletion) throw new ProviderError({code:"upstream_error",message:"Provider ended without a completion event.",details:{kind:"protocol"}});
        const finalUsage: OpenAIUsage = providerUsage
          ? {
              prompt_tokens: providerUsage.promptTokens,
              completion_tokens: providerUsage.completionTokens,
              total_tokens: providerUsage.totalTokens,
            }
          : estimateTokens(normalized, accumulatedContent.length);

        // Record usage for every completed request
        opts.usageTracker.record(model, finalUsage);

        const toolCallsList = Array.from(toolCallsMap.entries())
          .sort(([a], [b]) => a - b)
          .map(([, tc]) => tc);

        // JSON mode must return raw JSON: the upstream sometimes wraps the
        // payload in a Markdown fence, which would break JSON.parse().
        const finalContent = normalized.responseFormat
          ? stripJsonFence(accumulatedContent)
          : accumulatedContent;

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
                content: finalContent.length > 0 ? finalContent : null,
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

    // Resolve the first provider event before committing HTTP 200 headers.
    const iterator = opts.provider.chat(normalized)[Symbol.asyncIterator]();
    let first: IteratorResult<import("../types/provider").ProviderEvent>;
    try {
      first = await abortable(iterator.next(),normalized.signal!);
      if(first.done) throw new ProviderError({code:"upstream_error",message:"Provider returned no completion events."});
      if(first.value.type === "error") throw new ProviderError(first.value.error);
    } catch(error) {
      void iterator.return?.().catch(()=>undefined);
      cleanupListeners();
      const {status,body}=mapProviderErrorToHttp(error);
      return reply.status(status).send(body);
    }
    async function* preparedEvents() {
      try { yield first.value; yield* {[Symbol.asyncIterator]:()=>iterator}; }
      finally { void iterator.return?.().catch(()=>undefined); }
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

    const writer = createSseWriter(reply.raw,normalized.signal!);
    const heartbeatInterval = setInterval(writer.heartbeat,15000);
    const writeSseFrame = (data: unknown) => writer.write(`data: ${JSON.stringify(data)}\n\n`);
    const writeError = (error: unknown) => {
      const {body}=mapProviderErrorToHttp(error);
      if(reply.raw.destroyed || reply.raw.writableEnded) return;
      // A deadline may already have aborted the writer. Emit one bounded terminal
      // frame only when writable; otherwise close the stalled connection.
      if(reply.raw.writableNeedDrain) { reply.raw.destroy(); return; }
      reply.raw.end(`data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`);
    };

    let streamId = generateChatCompletionId();
    let streamModel = normalized.model;
    let streamCreated = Math.floor(Date.now() / 1000);
    let roleChunkSent = false;
    let generatedChars = 0;
    let providerUsage: UsageInfo | undefined;
    let finishReason: FinishReason = "stop";
    let completedNormally = false;
    // JSON mode: strip a Markdown fence the upstream may add around the payload.
    const fenceFilter = normalized.responseFormat
      ? createJsonFenceFilter()
      : undefined;

    try {
      for await (const event of preparedEvents()) {
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
          await writeSseFrame(createRoleChunk(streamId, streamModel, streamCreated));
          roleChunkSent = true;
        } else if (event.type === "delta") {
          if (!roleChunkSent) {
            await writeSseFrame(createRoleChunk(streamId, streamModel, streamCreated));
            roleChunkSent = true;
          }
          const text = fenceFilter ? fenceFilter.push(event.text) : event.text;
          countOutput(event.text);
          generatedChars += text.length;
          if (text) {
            await writeSseFrame(
              createContentChunk(streamId, streamModel, streamCreated, text),
            );
          }
        } else if (event.type === "tool_call_delta") {
          countOutput((event.argumentsDelta ?? "") + (event.name ?? "") + (event.id ?? ""));
          if (!roleChunkSent) {
            await writeSseFrame(createRoleChunk(streamId, streamModel, streamCreated));
            roleChunkSent = true;
          }
          await writeSseFrame(
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
          if (event.finishReason === "error") throw new ProviderError({code:"upstream_error",message:"Provider reported a failed completion."});
          // Flush anything the JSON fence filter still holds back.
          const tail = fenceFilter ? fenceFilter.finish() : "";
          if (tail) {
            generatedChars += tail.length;
            await writeSseFrame(
              createContentChunk(streamId, streamModel, streamCreated, tail),
            );
          }
          finishReason = event.finishReason;
          if (event.usage) {
            providerUsage = event.usage;
          }

          if (!roleChunkSent) {
            await writeSseFrame(createRoleChunk(streamId, streamModel, streamCreated));
            roleChunkSent = true;
          }

          await writeSseFrame(
            createFinishChunk(streamId, streamModel, streamCreated, finishReason),
          );

          if (streamOptions?.include_usage) {
            const usageData: OpenAIUsage = providerUsage
              ? {
                  prompt_tokens: providerUsage.promptTokens,
                  completion_tokens: providerUsage.completionTokens,
                  total_tokens: providerUsage.totalTokens,
                }
              : estimateTokens(normalized, generatedChars);
            await writeSseFrame(
              createUsageChunk(streamId, streamModel, streamCreated, usageData),
            );
          }

          if (!reply.raw.writableEnded && !reply.raw.destroyed) {
            await writer.write("data: [DONE]\n\n");
          }
          completedNormally = true;
          break;
        } else if (event.type === "error") {
          writeError(new ProviderError(event.error));
          break;
        }
      }
      if(!completedNormally && !reply.raw.writableEnded && !reply.raw.destroyed && !normalized.signal?.aborted) {
        throw new ProviderError({code:"upstream_error",message:"Provider stream ended without completion."});
      }
    } catch (err) {
      writeError(normalized.signal?.aborted ? cancellationReason(normalized.signal) : err);
    } finally {
      clearInterval(heartbeatInterval);
      cleanupListeners();

      // Record usage for every completed or partially completed request
      if (completedNormally || generatedChars > 0 || providerUsage) {
        const finalUsage: OpenAIUsage = providerUsage
          ? {
              prompt_tokens: providerUsage.promptTokens,
              completion_tokens: providerUsage.completionTokens,
              total_tokens: providerUsage.totalTokens,
            }
          : estimateTokens(normalized, generatedChars);
        opts.usageTracker.record(streamModel, finalUsage);
      }

      if (!reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.end();
      }
    }
  });
};
