import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app";
import { loadConfig } from "../../src/config/env";
import { AntigravityProvider } from "../../src/providers/antigravity";

/** Synthetic client request forms; no private conversations or upstream credentials. */
const fixtures = [
  { name: "SDK text", messages: [{ role: "user", content: "hello" }] },
  {
    name: "Cline/5ire text array",
    messages: [
      { role: "developer", content: "help" },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ],
  },
  {
    name: "OpenAI image",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,YQ==" },
          },
        ],
      },
    ],
  },
  {
    name: "Anthropic image",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "YQ==" },
          },
        ],
      },
    ],
  },
  {
    name: "JSON object",
    messages: [{ role: "user", content: "hello" }],
    response_format: { type: "json_object" },
  },
  {
    name: "JSON schema",
    messages: [{ role: "user", content: "hello" }],
    response_format: {
      type: "json_schema",
      json_schema: {
        schema: { type: "object", properties: { ok: { type: "boolean" } } },
      },
    },
  },
  {
    name: "parallel tool results",
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "a",
            type: "function",
            function: { name: "weather", arguments: '{"city":"Paris"}' },
          },
          {
            id: "b",
            type: "function",
            function: { name: "weather", arguments: '{"city":"Cairo"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "b", content: "30C" },
      { role: "tool", tool_call_id: "a", content: "18C" },
    ],
  },
];
describe("offline client compatibility matrix", () => {
  for (const fixture of fixtures)
    for (const stream of [false, true])
      it(`${fixture.name}: stream=${stream}`, async () => {
        let wire: Record<string, unknown> = {};
        const provider = new AntigravityProvider(
          { accessToken: "test" },
          {
            fetch: async (_url, init) => {
              wire = JSON.parse(String(init?.body)) as typeof wire;
              return new Response(
                'data: {"response":{"candidates":[{"content":{"parts":[{"text":"{\\"ok\\":true}"}]},"finishReason":"STOP"}]}}\n\n',
              );
            },
          },
        );
        const app = await buildApp({
          config: loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
          provider,
        });
        try {
          const response = await app.inject({
            method: "POST",
            url: "/v1/chat/completions",
            payload: {
              model: "client-label",
              ...fixture,
              stream,
              stream_options: { include_usage: true },
            },
          });
          expect(response.statusCode).toBe(200);
          if (stream) {
            expect(response.body).toContain('"finish_reason":"stop"');
            expect(response.body.match(/data: \[DONE\]/g)).toHaveLength(1);
          } else
            expect(
              JSON.parse(response.json().choices[0].message.content),
            ).toEqual({ ok: true });
          expect(wire.model).toBe("gemini-3.8-flash-tiered");
          expect(JSON.stringify(wire)).toContain('"thinkingLevel":"HIGH"');
          if (fixture.name === "parallel tool results") {
            expect(JSON.stringify(wire)).toContain(
              '"functionResponse":{"id":"b","name":"weather","response":{"output":"30C"}}',
            );
          }
        } finally {
          await app.close();
        }
      });
});
