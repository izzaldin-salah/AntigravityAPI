import { describe, expect, it } from "vitest";
import {
  createJsonFenceFilter,
  stripJsonFence,
} from "../../src/core/json-fence";

describe("json fence handling", () => {
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
