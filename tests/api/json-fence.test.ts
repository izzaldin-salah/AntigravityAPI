import { describe, expect, it } from "vitest";
import {
  createJsonFenceFilter,
  stripJsonFence,
} from "../../src/core/json-fence";

describe("json fence handling", () => {
  function filtered(parts: string[]): string {
    const filter = createJsonFenceFilter();
    const output = parts.map(part => filter.push(part)).join("") + filter.finish();
    expect(filter.finish()).toBe("");
    return output;
  }

  it("preserves JSON values across every boundary including literal backticks", () => {
    for (const text of [
      '```json\n{"ok":true}\n```',
      ' \r\n```json\r\n{"code":"```","unicode":"é"}\r\n```  ',
      '```\n{"ok":true}\n```',
      '  {"code":"```"}  ',
      '```json\n{"ok":true}',
    ]) {
      for (let split = 0; split <= text.length; split++) {
        expect(JSON.parse(filtered([text.slice(0, split), "", text.slice(split)])))
          .toEqual(JSON.parse(stripJsonFence(text)));
      }
      expect(JSON.parse(filtered([...text]))).toEqual(JSON.parse(stripJsonFence(text)));
    }
    expect(filtered(['```json\n', '{"ok":true}\n', '``', '`']).trim()).toBe('{"ok":true}');
    expect(JSON.parse(filtered(['```json\n', '{"code":"```"}', '\n```']))).toEqual({code:"```"});
  });

  it("passes incomplete prefixes through and bounds undecided prefixes", () => {
    for (const text of ["", "`", "``", "```json", "  {\"ok\":true}  ", " ".repeat(5000)]) {
      expect(filtered([...text])).toBe(text);
    }
  });
  it("strips a fenced json payload", () => {
    expect(
      stripJsonFence('```json\n{"capital":"Paris"}\n```'),
    ).toBe('{"capital":"Paris"}');
  });

  it("strips a fence without a language tag", () => {
    expect(stripJsonFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("leaves an unfenced payload untouched", () => {
    expect(stripJsonFence('{"a":1}')).toBe('{"a":1}');
  });

  it("removes only a leading fence when the payload is unterminated", () => {
    expect(stripJsonFence('```json\n{"a":1}')).toBe('{"a":1}');
  });

  it("passes an unfenced stream through unchanged", () => {
    const filter = createJsonFenceFilter();
    expect(filter.push('{"a"')).toBe('{"a"');
    expect(filter.push(':1}')).toBe(':1}');
    expect(filter.finish()).toBe("");
  });

  it("removes fence markers from a fenced stream", () => {
    const filter = createJsonFenceFilter();
    expect(filter.push("```js")).toBe("");
    expect(filter.push("on\n")).toBe("");
    expect(filter.push('{"a"')).toBe('{"a"');
    expect(filter.push(":1}\n```")).toBe(":1}\n");
    expect(filter.finish()).toBe("");
  });

  it("handles a fence split across deltas", () => {
    const filter = createJsonFenceFilter();
    expect(filter.push("`")).toBe("");
    expect(filter.push("``json\n{\"a\":1}")).toBe('{"a":1}');
  });

  it("passes through a payload that only looks like a fence", () => {
    const filter = createJsonFenceFilter();
    expect(filter.push("``json\n")).toBe("``json\n");
  });
});
