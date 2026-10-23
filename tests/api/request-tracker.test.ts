import { describe, expect, it } from "vitest";
import { RequestTracker } from "../../src/core/request-tracker";
import { ProviderError, type ProviderEvent } from "../../src/types/provider";

const request = {
  model: "m",
  messages: [],
  stream: true,
  requestId: "metrics",
};
async function drain(events: AsyncIterable<ProviderEvent>) {
  for await (const _ of events) {
    /* consume */
  }
}
describe("bounded request metrics", () => {
  it("counts a route-enforced response limit as failure rather than client cancellation",async()=>{
    const tracker=new RequestTracker();const caller=new AbortController();
    async function* events():AsyncGenerator<ProviderEvent>{yield {type:"delta",text:"too large"};}
    const iterator=tracker.observe({...request,signal:caller.signal},events(),"api")[Symbol.asyncIterator]();
    await iterator.next();caller.abort(new ProviderError({code:"upstream_error",message:"size limit",details:{kind:"limit"}}));
    await iterator.return?.();
    expect(tracker.snapshot()).toMatchObject({failed:1,cancelled:0,failureCounts:{limit:1}});
  });
  it("records active requests, first visible output and rolling percentiles", async () => {
    let now = 0;
    const tracker = new RequestTracker(() => now);
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: "start", id: "id", model: "m", created: 0 };
      now = 10;
      yield { type: "delta", text: "" };
      now = 20;
      yield { type: "tool_call_delta", index: 0, name: "tool" };
      now = 100;
      yield { type: "done", finishReason: "tool_calls" };
    }
    const iterator = tracker
      .observe(request, events(), "api")
      [Symbol.asyncIterator]();
    await iterator.next();
    expect(tracker.snapshot().activeRequests).toBe(1);
    await drain({ [Symbol.asyncIterator]: () => iterator });
    const result = tracker.snapshot();
    expect(result.activeRequests).toBe(0);
    expect(result.recent[0].firstOutputMs).toBe(20);
    expect(result.latency.completion).toEqual({ p50Ms: 100, p95Ms: 100 });
    expect(result.latency.firstOutput).toEqual({ p50Ms: 20, p95Ms: 20 });
    for (let i = 0; i < 60; i++)
      await drain(
        tracker.observe(
          request,
          (async function* () {
            yield { type: "done", finishReason: "stop" } as const;
          })(),
          "connection test",
        ),
      );
    expect(tracker.snapshot().recent).toHaveLength(50);
    expect(tracker.snapshot().latency.firstOutput.p50Ms).toBeNull();
    expect(new RequestTracker().snapshot().latency.completion.p95Ms).toBeNull();
  });
  it("classifies typed failures, timeout and caller cancellation without storing content", async () => {
    const tracker = new RequestTracker();
    for (const [code, kind] of [
      ["timeout", undefined],
      ["upstream_error", "protocol"],
      ["upstream_error", undefined],
    ]) {
      const error = new ProviderError({
        code: code!,
        message: "PRIVATE_PROMPT_SENTINEL",
        details: { kind },
      });
      await expect(
        drain(
          tracker.observe(
            request,
            (async function* () {
              throw error;
            })(),
            "api",
          ),
        ),
      ).rejects.toBe(error);
    }
    const caller = new AbortController();
    async function* cancelled(): AsyncGenerator<ProviderEvent> {
      caller.abort();
      throw new Error("cancelled");
    }
    await expect(
      drain(
        tracker.observe(
          { ...request, signal: caller.signal },
          cancelled(),
          "api",
        ),
      ),
    ).rejects.toThrow();
    expect(tracker.snapshot()).toMatchObject({
      activeRequests: 0,
      failed: 3,
      cancelled: 1,
      failureCounts: { timeout: 1, protocol: 1, upstream: 1 },
    });
    expect(JSON.stringify(tracker.snapshot())).not.toContain(
      "PRIVATE_PROMPT_SENTINEL",
    );
  });
});
