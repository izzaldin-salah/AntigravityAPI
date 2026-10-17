export interface UpstreamPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: {
    name: string;
    args: Record<string, unknown>;
    id?: string;
  };
}

export interface UpstreamCandidate {
  content?: {
    role: string;
    parts?: UpstreamPart[];
  };
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
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>,
  signal?: AbortSignal,
): AsyncIterable<UpstreamChunk> {
  const decoder = new TextDecoder();
  let buffer = "";

  const iterable: AsyncIterable<Uint8Array | string> =
    Symbol.asyncIterator in stream
      ? (stream as AsyncIterable<Uint8Array | string>)
      : {
          [Symbol.asyncIterator]() {
            const reader = (stream as ReadableStream<Uint8Array>).getReader();
            return {
              async next() {
                const { done, value } = await reader.read();
                if (done) return { done: true, value: undefined };
                return { done: false, value };
              },
            };
          },
        };

  for await (const rawChunk of iterable) {
    if (signal?.aborted) {
      return;
    }

    const chunkText = typeof rawChunk === "string" ? rawChunk : decoder.decode(rawChunk, { stream: true });
    buffer += chunkText;

    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) {
        continue;
      }

      if (trimmed.startsWith("data:")) {
        const dataPayload = trimmed.slice(5).trim();
        if (dataPayload === "[DONE]") {
          return;
        }

        try {
          const parsed = JSON.parse(dataPayload) as UpstreamChunk;
          yield parsed;
        } catch {
          // Skip invalid JSON lines
        }
      }
    }
  }

  // Handle any remaining text in buffer
  if (buffer.trim().startsWith("data:")) {
    const dataPayload = buffer.trim().slice(5).trim();
    if (dataPayload !== "[DONE]") {
      try {
        const parsed = JSON.parse(dataPayload) as UpstreamChunk;
        yield parsed;
      } catch {
        // Skip
      }
    }
  }
}
