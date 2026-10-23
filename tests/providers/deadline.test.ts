import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatDeadline, abortable } from "../../src/core/chat-deadline";
import { AntigravityProvider } from "../../src/providers/antigravity";
import { loadConfig } from "../../src/config/env";

afterEach(() => vi.useRealTimers());
describe("chat deadlines", () => {
  it("validates deadline configuration and exposes defaults", () => {
    expect(loadConfig({ NODE_ENV: "test" }).provider.timeouts).toEqual({
      firstResponseMs: 120000,
      idleMs: 120000,
      totalMs: 600000,
    });
    for (const value of ["0", "-1", "abc", "1.5", "2147483648"])
      expect(() =>
        loadConfig({ NODE_ENV: "test", ANTIGRAVITY_REQUEST_TIMEOUT_MS: value }),
      ).toThrow();
  });
  it("distinguishes first response, idle and total timeouts", async () => {
    vi.useFakeTimers();
    for (const kind of ["first response", "idle", "total"]) {
      const d = createChatDeadline(undefined, {
        firstResponseMs: 10,
        idleMs: 10,
        totalMs: kind === "total" ? 15 : 100,
      });
      if (kind !== "first response") d.progress();
      if (kind === "total") {
        vi.advanceTimersByTime(9);
        d.progress();
        vi.advanceTimersByTime(6);
      } else vi.advanceTimersByTime(10);
      expect(d.signal.reason?.payload).toMatchObject({ code: "timeout" });
      expect(d.signal.reason.message).toContain(kind);
      d.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves caller cancellation and interrupts blocked promises", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const d = createChatDeadline(caller.signal);
    const pending = abortable(new Promise(() => {}), d.signal);
    const rejection = expect(pending).rejects.toMatchObject({
      payload: { code: "aborted" },
    });
    caller.abort();
    await rejection;
    d.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("times out preparation and a body read that never completes", async () => {
    vi.useFakeTimers();
    for (const stage of ["preparation", "fetch", "body"]) {
      const provider = new AntigravityProvider(
        { accessToken: "test" },
        {
          timeouts: { firstResponseMs: 10, idleMs: 10, totalMs: 30 },
          fetch: async () =>
            stage === "fetch"
              ? new Promise<Response>(() => {})
              : new Response(new ReadableStream({})),
        },
      );
      if (stage === "preparation")
        vi.spyOn(provider, "getModelSettings").mockImplementation(
          () => new Promise(() => {}),
        );
      const read = (async () => {
        for await (const _ of provider.chat({
          model: "m",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
          requestId: "deadline",
        })) {
          /* drain */
        }
      })();
      const rejection = expect(read).rejects.toMatchObject({
        payload: { code: "timeout" },
      });
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});
