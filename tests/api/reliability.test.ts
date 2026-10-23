import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app";
import { loadConfig } from "../../src/config/env";
import { AntigravityProvider } from "../../src/providers/antigravity";
import type { AIProvider, ProviderEvent } from "../../src/types/provider";

async function fixture(body: string, limits: Record<string, string> = {}) {
  const config = loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    ...limits,
  });
  const provider = new AntigravityProvider(
    { accessToken: "test" },
    { fetch: async () => new Response(body) },
  );
  const app = await buildApp({ config, provider });
  return {
    app,
    send: (stream: boolean, extra = {}) =>
      app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "m",
          messages: [{ role: "user", content: "hi" }],
          stream,
          ...extra,
        },
      }),
  };
}
const complete =
  'data: {"response":{"candidates":[{"content":{"parts":[{"text":"abcdefghij"}]},"finishReason":"STOP"}]}}\n\n';
describe("API reliability integration", () => {
  it("does not turn a missing or failed provider terminal event into success",async()=>{
    for(const terminal of ["missing","error"]) {
      const provider:AIProvider={id:"fixture",listModels:async()=>[],getUsage:async()=>({promptTokens:0,completionTokens:0,totalTokens:0}),
        async *chat():AsyncGenerator<ProviderEvent>{yield {type:"start",id:"id",model:"m",created:1};yield {type:"delta",text:"partial"};if(terminal==="error") yield {type:"done",finishReason:"error"};},
      };
      const app=await buildApp({config:loadConfig({NODE_ENV:"test",LOG_LEVEL:"silent"}),provider});
      try {
        for(const stream of [false,true]) {
          const response=await app.inject({method:"POST",url:"/v1/chat/completions",payload:{model:"m",messages:[{role:"user",content:"hi"}],stream}});
          if(stream){expect(response.body).toContain('"error"');expect(response.body).not.toContain('"finish_reason":"stop"');}
          else expect(response.statusCode).toBe(502);
        }
      } finally {await app.close();}
    }
  });
  it("returns a 502 for incomplete nonstream output, and a single streaming error", async () => {
    const { app, send } = await fixture(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}}\n\n',
    );
    try {
      expect((await send(false)).statusCode).toBe(502);
      const stream = await send(true);
      expect(stream.body).toContain('"error"');
      expect(stream.body.match(/data: \[DONE\]/g)).toHaveLength(1);
      expect(stream.body).not.toContain('"finish_reason":"stop"');
    } finally {
      await app.close();
    }
  });
  it("enforces output limits in both modes without successful completion", async () => {
    const { app, send } = await fixture(complete, {
      ANTIGRAVITY_MAX_RESPONSE_BYTES: "5",
    });
    try {
      expect((await send(false)).statusCode).toBe(502);
      const stream = await send(true);
      expect(stream.body).toContain("byte limit");
      expect(stream.body).not.toContain('"finish_reason":"stop"');
    } finally {
      await app.close();
    }
  });
  it("rejects an unknown named tool before any upstream fetch", async () => {
    const { app, send } = await fixture(complete);
    try {
      expect(
        (
          await send(false, {
            tools: [{ type: "function", function: { name: "known" } }],
            tool_choice: { type: "function", function: { name: "missing" } },
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
  it("keeps the 25 MiB HTTP body cap independent of image limits", async () => {
    const { app } = await fixture(complete);
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/chat/completions",
            headers: { "content-type": "application/json" },
            payload: JSON.stringify({ text: "a".repeat(25 * 1024 * 1024) }),
          })
        ).statusCode,
      ).toBe(413);
    } finally {
      await app.close();
    }
  });
  it("returns HTTP 504 before SSE headers when upstream stalls", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      ANTIGRAVITY_FIRST_RESPONSE_TIMEOUT_MS: "10",
    });
    const provider = new AntigravityProvider(
      { accessToken: "test" },
      { fetch: async () => new Response(new ReadableStream({})) },
    );
    const app = await buildApp({ config, provider });
    try {
      const result = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "m",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        },
      });
      expect(result.statusCode).toBe(504);
      expect(result.json().error.code).toBe("upstream_timeout");
    } finally {
      await app.close();
    }
  });
});
