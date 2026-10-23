import type { EventEmitter } from "node:events";
import { ProviderError } from "../types/provider";
import { cancellationReason } from "./chat-deadline";

interface ResponseSink extends EventEmitter {
  writableEnded: boolean;
  destroyed: boolean;
  writableNeedDrain?: boolean;
  write(data: string): boolean;
}

/** One awaited data write at a time; heartbeats are skipped while data is pending. */
export function createSseWriter(sink: ResponseSink, signal: AbortSignal) {
  let busy = false;
  async function write(data: string): Promise<void> {
    if (signal.aborted) throw cancellationReason(signal);
    if (sink.destroyed || sink.writableEnded)
      throw new ProviderError({ code: "aborted", message: "Response closed." });
    busy = true;
    try {
      if (sink.write(data)) return;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          sink.off("drain", drain);
          sink.off("close", closed);
          sink.off("error", failed);
          signal.removeEventListener("abort", aborted);
        };
        const drain = () => {
          cleanup();
          resolve();
        };
        const failed = (error: Error) => {
          cleanup();
          reject(error);
        };
        const closed = () =>
          failed(
            new ProviderError({
              code: "aborted",
              message: "Response closed during write.",
            }),
          );
        const aborted = () => failed(cancellationReason(signal));
        sink.once("drain", drain);
        sink.once("close", closed);
        sink.once("error", failed);
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
        else if (sink.destroyed || sink.writableEnded) closed();
      });
    } finally {
      busy = false;
    }
  }
  return {
    write,
    heartbeat: () => {
      if (
        !busy &&
        !signal.aborted &&
        !sink.writableNeedDrain &&
        !sink.destroyed &&
        !sink.writableEnded
      ) {
        void write(": keep-alive\n\n").catch(() => undefined);
      }
    },
  };
}
