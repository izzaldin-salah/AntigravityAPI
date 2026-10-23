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
      expect(properties.count).toEqual({ type: "integer", description: "{const: 3}" });
    });

    it("keeps accepted keywords and describes unsupported object constraints", () => {
      const sanitized = sanitizeSchemaForCca({
        type: "object",
        description: "root",
        properties: { city: { type: "string", description: "city name", enum: ["a", "b"] } },
        additionalProperties: false,
      }) as Record<string, unknown>;

      expect(sanitized.description).toBe("root\n\n{additionalProperties: false}");
      expect(sanitized).not.toHaveProperty("additionalProperties");
      expect(sanitized.properties).toEqual({ city: { type: "string", description: "city name", enum: ["a", "b"] } });
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

    it("describes an unresolvable $ref instead of forwarding a rejected field", () => {
      const sanitized = sanitizeSchemaForCca({
        type: "object",
        properties: { item: { $ref: "#/$defs/Missing" } },
      }) as Record<string, unknown>;

      expect(sanitized.properties).toEqual({ item: { description: "Unresolved schema reference: #/$defs/Missing" } });
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
    it("restricts named declarations even without toolConfig and rejects unknown names", () => {
      const tools: ToolDefinition[] = [weatherTool,{type:"function",function:{name:"get_time"}}];
      const plans = ["get_weather","get_time"].map(name => planToolCall({tools,toolChoice:{type:"function",function:{name}}}));
      expect(plans[0].tools?.[0].functionDeclarations.map(fn => fn.name)).toEqual(["get_weather"]);
      expect(plans[1].tools?.[0].functionDeclarations.map(fn => fn.name)).toEqual(["get_time"]);
      expect(plans[0].forcedDirective).toContain("get_weather");
      expect(plans[1].forcedDirective).toContain("get_time");
      expect(() => planToolCall({tools,toolChoice:{type:"function",function:{name:"missing"}}})).toThrow(/declared/);
      expect(() => planToolCall({toolChoice:{type:"function",function:{name:"missing"}}})).toThrow(/declared/);
      expect(() => planToolCall({tools,toolChoice:{type:"function",function:{name:""}}})).toThrow(/declared/);
    });
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
      expect(plan.forcedDirective).toBe(`${FORCED_TOOL_DIRECTIVE} Call the function "get_weather".`);
    });
  });

  describe("tool result mapping", () => {
    it("keeps correlation when same-name results arrive in reverse order", () => {
      const names = new Map([["paris","get_weather"],["cairo","get_weather"]]);
      const results = ["cairo","paris"].map(id => buildFunctionResponsePart({role:"tool",tool_call_id:id,content:id},names));
      expect(results.map(part => part?.functionResponse)).toEqual([
        {id:"cairo",name:"get_weather",response:{output:"cairo"}},
        {id:"paris",name:"get_weather",response:{output:"paris"}},
      ]);
      expect(buildFunctionResponsePart({role:"tool",name:"legacy",content:"ok"},names)?.functionResponse).not.toHaveProperty("id");
    });
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
        functionResponse: { id: "call_abc", name: "get_weather", response: { output: "18C" } },
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
