import { describe, expect, it } from "vitest";
import {
  FORCED_TOOL_DIRECTIVE,
  buildFunctionResponsePart,
  buildUpstreamTools,
  collectToolCallNames,
  planToolCall,
  sanitizeSchemaForCca,
} from "../../src/providers/tools";
import type { ChatMessage, ToolDefinition } from "../../src/types/provider";

const weatherTool: ToolDefinition = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Look up the weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

describe("tool mapping helpers", () => {
  describe("sanitizeSchemaForCca", () => {
    it("drops keywords the Cloud Code Assist schema proto rejects", () => {
      const sanitized = sanitizeSchemaForCca({
        type: "object",
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: { Thing: { type: "string" } },
        properties: {
          name: { type: "string", readOnly: true, deprecated: true },
          count: { type: "integer", const: 3 },
        },
        required: ["name"],
        additionalItems: false,
        contentEncoding: "base64",
      }) as Record<string, unknown>;

      expect(sanitized).not.toHaveProperty("$schema");
      expect(sanitized).not.toHaveProperty("$defs");
      expect(sanitized).not.toHaveProperty("additionalItems");
      expect(sanitized).not.toHaveProperty("contentEncoding");
      expect(sanitized.required).toEqual(["name"]);
      expect(sanitized.type).toBe("object");

      const properties = sanitized.properties as Record<string, Record<string, unknown>>;
      expect(properties.name).toEqual({ type: "string" });
      expect(properties.count).toEqual({ type: "integer" });
    });

    it("keeps keywords the upstream accepts", () => {
      const sanitized = sanitizeSchemaForCca({
        type: "object",
        description: "root",
        properties: { city: { type: "string", description: "city name" } },
        additionalProperties: false,
        enum: ["a", "b"],
      }) as Record<string, unknown>;

      expect(sanitized.description).toBe("root");
      expect(sanitized.additionalProperties).toBe(false);
      expect(sanitized.enum).toEqual(["a", "b"]);
    });

    it("inlines local $ref pointers and removes the $defs block", () => {
      const sanitized = sanitizeSchemaForCca({
        type: "object",
        properties: { item: { $ref: "#/$defs/Item" } },
        $defs: { Item: { type: "string", enum: ["x"] } },
      }) as Record<string, unknown>;

      expect(sanitized).not.toHaveProperty("$defs");
      expect(sanitized.properties).toEqual({ item: { type: "string", enum: ["x"] } });
    });

    it("replaces an unresolvable $ref with an empty schema instead of failing", () => {
      const sanitized = sanitizeSchemaForCca({
        type: "object",
        properties: { item: { $ref: "#/$defs/Missing" } },
      }) as Record<string, unknown>;

      expect(sanitized.properties).toEqual({ item: {} });
    });
  });

  describe("buildUpstreamTools", () => {
    it("groups every function into a single functionDeclarations group", () => {
      const tools = buildUpstreamTools([
        weatherTool,
        { type: "function", function: { name: "get_time" } },
      ]);

      expect(tools).toHaveLength(1);
      expect(tools?.[0].functionDeclarations).toHaveLength(2);
      expect(tools?.[0].functionDeclarations[0]).toEqual({
        name: "get_weather",
        description: "Look up the weather for a city.",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      });
      expect(tools?.[0].functionDeclarations[1]).toEqual({ name: "get_time" });
    });

    it("returns undefined when there are no tools", () => {
      expect(buildUpstreamTools(undefined)).toBeUndefined();
      expect(buildUpstreamTools([])).toBeUndefined();
    });
  });

  describe("planToolCall", () => {
    it("ignores tool_choice when the client declared no tools", () => {
      expect(planToolCall({ toolChoice: "required" })).toEqual({});
    });

    it("uses Antigravity's default VALIDATED mode for auto", () => {
      const plan = planToolCall({ tools: [weatherTool], toolChoice: "auto" });
      expect(plan.tools).toHaveLength(1);
      expect(plan.toolConfig).toEqual({
        functionCallingConfig: { mode: "VALIDATED" },
      });
      expect(plan.forcedDirective).toBeUndefined();
    });

    it("declares no tools at all when the client forbids tool use", () => {
      // Cloud Code Assist ignores mode NONE on Antigravity's Gemini routes and
      // still emits calls, so the tools must not be declared.
      const plan = planToolCall({ tools: [weatherTool], toolChoice: "none" });
      expect(plan).toEqual({});
    });

    it("forces ANY plus a transcript directive for tool_choice required", () => {
      const plan = planToolCall({ tools: [weatherTool], toolChoice: "required" });
      expect(plan.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY" } });
      expect(plan.forcedDirective).toBe(FORCED_TOOL_DIRECTIVE);
    });

    it("forces a named function with allowedFunctionNames", () => {
      const plan = planToolCall({
        tools: [weatherTool],
        toolChoice: { type: "function", function: { name: "get_weather" } },
      });
      expect(plan.toolConfig).toEqual({
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["get_weather"] },
      });
      expect(plan.forcedDirective).toBe(FORCED_TOOL_DIRECTIVE);
    });
  });

  describe("tool result mapping", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "weather in Paris?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_abc",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Paris"}' },
          },
        ],
      },
      { role: "tool", content: "18C", tool_call_id: "call_abc" },
    ];

    it("resolves the function name from the assistant tool call", () => {
      const names = collectToolCallNames(messages);
      expect(names.get("call_abc")).toBe("get_weather");

      const part = buildFunctionResponsePart(messages[2], names);
      expect(part).toEqual({
        functionResponse: { name: "get_weather", response: { output: "18C" } },
      });
    });

    it("falls back to the message name when no tool call id is present", () => {
      const part = buildFunctionResponsePart(
        { role: "tool", content: "sunny", name: "get_weather" },
        new Map(),
      );
      expect(part?.functionResponse.name).toBe("get_weather");
    });

    it("returns null when the function name cannot be resolved", () => {
      const part = buildFunctionResponsePart(
        { role: "tool", content: "18C", tool_call_id: "call_unknown" },
        new Map(),
      );
      expect(part).toBeNull();
    });
  });
});
