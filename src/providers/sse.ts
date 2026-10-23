import { ProviderError } from "../types/provider";
import { abortable } from "../core/chat-deadline";

export interface UpstreamPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args: Record<string, unknown>; id?: string };
}
export interface UpstreamCandidate {
  content?: { role: string; parts?: UpstreamPart[] };
  finishReason?: string;
}
export interface UpstreamUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}
export interface UpstreamResponsePayload {
  candidates?: UpstreamCandidate[];
  usageMetadata?: UpstreamUsageMetadata;
  modelVersion?: string;
  responseId?: string;
}
export interface UpstreamChunk {
  response?: UpstreamResponsePayload;
  error?: { code?: number; message?: string; status?: string };
}
export const MAX_SSE_EVENT_BYTES = 16 * 1024 * 1024;
export function protocolError(message: string): ProviderError {
  return new ProviderError({
    code: "upstream_error",
    message,
    status: 502,
    details: { kind: "protocol" },
  });
}

/** SSE framing is independent of both UTF-8 and network packet boundaries. */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>,
  signal?: AbortSignal,
): AsyncIterable<UpstreamChunk> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let data: string[] = [];
  let eventBytes = 0;
  const decodeEvent = (): UpstreamChunk | "done" | undefined => {
    if (data.length === 0) {
      eventBytes = 0;
      return undefined;
    }
    const payload = data.join("\n");
    data = [];
    eventBytes = 0;
    if (payload.trim() === "[DONE]") return "done";
    try {
      const parsed: unknown = JSON.parse(payload);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error();
      return parsed as UpstreamChunk;
    } catch {
      throw protocolError("Upstream sent malformed SSE JSON.");
    }
  };
  function line(value: string): UpstreamChunk | "done" | undefined {
    if (value.endsWith("\r")) value = value.slice(0, -1);
    if (value === "") return decodeEvent();
    eventBytes += Buffer.byteLength(value);
    if (eventBytes > MAX_SSE_EVENT_BYTES)
      throw protocolError("Upstream SSE event exceeds the 16 MiB limit.");
    if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""));
    return undefined;
  }
  try {
    for await (const chunk of cancellableChunks(stream, signal)) {
      signal?.throwIfAborted();
      pending +=
        typeof chunk === "string"
          ? chunk
          : decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const result = line(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        if (result === "done") return;
        if (result) yield result;
      }
      if (Buffer.byteLength(pending) + eventBytes > MAX_SSE_EVENT_BYTES)
        throw protocolError("Upstream SSE event exceeds the 16 MiB limit.");
    }
    pending += decoder.decode();
    if (pending) line(pending);
    const result = decodeEvent();
    if (result && result !== "done") yield result;
  } catch (error) {
    if (error instanceof TypeError && !signal?.aborted)
      throw protocolError("Upstream sent invalid or truncated UTF-8.");
    throw error;
  }
}

async function* cancellableChunks(
  stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>,
  signal?: AbortSignal,
) {
  if ("getReader" in stream) {
    const reader = stream.getReader();
    try {
      while (true) {
        const result = await (signal
          ? abortable(reader.read(), signal)
          : reader.read());
        if (result.done) return;
        yield result.value;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } else {
    const iterator = stream[Symbol.asyncIterator]();
    try {
      while (true) {
        const result = await (signal
          ? abortable(iterator.next(), signal)
          : iterator.next());
        if (result.done) return;
        yield result.value;
      }
    } finally {
      void iterator.return?.().catch(() => undefined);
    }
  }
}
