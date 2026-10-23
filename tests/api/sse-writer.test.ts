import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createSseWriter } from "../../src/core/sse-writer";

class Sink extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  writableNeedDrain = false;
  frames: string[] = [];
  write(data: string) {
    this.frames.push(data);
    return !this.writableNeedDrain;
  }
}
describe("SSE backpressure", () => {
  it("pauses writes, drops heartbeats while blocked, and cleans listeners", async () => {
    const sink = new Sink();
    const caller = new AbortController();
    const writer = createSseWriter(sink, caller.signal);
    sink.writableNeedDrain = true;
    let completed = false;
    const write = writer.write("data").then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    writer.heartbeat();
    writer.heartbeat();
    expect(sink.frames).toEqual(["data"]);
    sink.writableNeedDrain = false;
    sink.emit("drain");
    await write;
    expect(completed).toBe(true);
    expect(sink.listenerCount("drain")).toBe(0);
    expect(sink.listenerCount("close")).toBe(0);
    writer.heartbeat();
    expect(sink.frames).toContain(": keep-alive\n\n");
  });
  it("interrupts a blocked write on close, error or cancellation", async () => {
    for (const mode of ["close", "error", "abort"]) {
      const sink = new Sink();
      sink.writableNeedDrain = true;
      const caller = new AbortController();
      const writer = createSseWriter(sink, caller.signal);
      const rejection = expect(writer.write("data")).rejects.toThrow();
      if (mode === "abort") caller.abort();
      else sink.emit(mode, new Error("closed"));
      await rejection;
      expect(sink.listenerCount("drain")).toBe(0);
      expect(sink.listenerCount("error")).toBe(0);
    }
  });
  it("does not consume another upstream value until downstream drains", async () => {
    const sink = new Sink();
    sink.writableNeedDrain = true;
    const writer = createSseWriter(sink, new AbortController().signal);
    const consumed = vi.fn();
    async function* source() {
      for (let i = 0; i < 3; i++) {
        consumed();
        yield String(i);
      }
    }
    const pending = (async () => {
      for await (const value of source()) await writer.write(value);
    })();
    await new Promise((resolve) => setImmediate(resolve));
    expect(consumed).toHaveBeenCalledTimes(1);
    sink.writableNeedDrain = false;
    sink.emit("drain");
    await pending;
    expect(consumed).toHaveBeenCalledTimes(3);
  });
});
