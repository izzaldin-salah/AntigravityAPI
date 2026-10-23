import { describe, expect, it } from "vitest";
import { parseSseStream } from "../../src/providers/sse";
import { AntigravityProvider } from "../../src/providers/antigravity";

async function collect(source: AsyncIterable<unknown>) {
  const values = [];
  for await (const value of source) values.push(value);
  return values;
}
async function* bytes(parts: (string | Uint8Array)[]) {
  yield* parts;
}
describe("upstream SSE integrity", () => {
  it("assembles multiline data, CRLF, comments, and split UTF-8", async () => {
    const text =
      ': ping\r\ndata: {"response":\r\ndata: {"responseId":"é"}}\r\n\r\ndata: [DONE]\r\n\r\n';
    const encoded = new TextEncoder().encode(text);
    for (let split = 0; split <= encoded.length; split++) {
      expect(
        await collect(
          parseSseStream(
            bytes([encoded.slice(0, split), encoded.slice(split)]),
          ),
        ),
      ).toEqual([{ response: { responseId: "é" } }]);
    }
  });
  it("rejects malformed JSON, invalid/truncated UTF-8, and oversized events", async () => {
    for (const parts of [
      ["data: {broken}\n\n"],
      ['data: {"response":'],
      [new Uint8Array([0xc3])],
      ["data: " + "a".repeat(16 * 1024 * 1024 + 1)],
    ]) {
      await expect(collect(parseSseStream(bytes(parts)))).rejects.toMatchObject(
        { payload: { code: "upstream_error" } },
      );
    }
  });
  it("accepts valid final buffered data", async () => {
    expect(
      await collect(
        parseSseStream(bytes(['data: {"response":{"responseId":"last"}}'])),
      ),
    ).toEqual([{ response: { responseId: "last" } }]);
  });
  it("rejects EOF and transport DONE without model completion evidence", async () => {
    for (const body of [
      "",
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}}\n\n',
      "data: [DONE]\n\n",
    ]) {
      const provider = new AntigravityProvider(
        { accessToken: "test" },
        { fetch: async () => new Response(body) },
      );
      await expect(
        collect(
          provider.chat({
            model: "model",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
            requestId: "integrity",
          }),
        ),
      ).rejects.toMatchObject({ payload: { code: "upstream_error" } });
    }
  });
});
