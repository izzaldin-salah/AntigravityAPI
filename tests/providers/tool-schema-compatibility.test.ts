import { describe, expect, it, vi } from "vitest";
import { AntigravityProvider } from "../../src/providers/antigravity";
import { sanitizeSchemaForCca } from "../../src/providers/json-schema";
import { buildUpstreamTools, planToolCall } from "../../src/providers/tools";
import { assertToolWireSchema, openCodeTool, reaTool } from "../fixtures/tool-schemas";

function normalize(schema: unknown): Record<string, unknown> {
  const result = sanitizeSchemaForCca(schema) as Record<string, unknown>;
  assertToolWireSchema(result);
  return result;
}

describe("OpenCode and REA tool schema compatibility", () => {
  it.each([openCodeTool, reaTool])("normalizes $function.name at the declaration boundary without mutation", tool => {
    const before = JSON.stringify(tool);
    const declaration = buildUpstreamTools([tool])![0].functionDeclarations[0];
    assertToolWireSchema(declaration.parameters);
    expect(declaration.name).toBe(tool.function.name);
    expect(JSON.stringify(tool)).toBe(before);
  });

  it("retains OpenCode bounds and string constraints in descriptions", () => {
    const schema = normalize(openCodeTool.function.parameters);
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.timeout).toMatchObject({ type: "number" });
    expect(properties.timeout.description).toContain("Timeout in milliseconds");
    expect(properties.timeout.description).toContain("exclusiveMinimum: 0");
    expect(properties.timeout.description).toContain("exclusiveMaximum: 600000");
    expect(properties.timeout.description).toContain("multipleOf: 1");
    expect(properties.session).toMatchObject({ type: "string", nullable: true });
    expect(properties.session.description).toContain('pattern: "^[a-z]+$"');
    expect(schema.description).toContain("additionalProperties: false");
  });

  it("preserves all arbitrary property names, including prototype and keyword names", () => {
    const names = ["exclusiveMinimum", "exclusiveMaximum", "x-mcp-header", "properties", "type", "anyOf", "const", "$ref", "__proto__", "constructor"];
    const schema = normalize({ type: "object", properties: Object.fromEntries(names.map(name => [name, { type: "number", exclusiveMinimum: 0, "x-mcp-header": name }])), required: names });
    expect(Object.keys(schema.properties as object)).toEqual(names);
    expect(schema.required).toEqual(names);
    for (const child of Object.values(schema.properties as object)) expect(child).toMatchObject({ type: "number", description: expect.stringContaining("exclusiveMinimum: 0") });
  });

  it("normalizes type-array branches with their applicable shapes and nullability", () => {
    const schema = normalize({ type: ["string", "array", "null"], items: { type: ["number", "null"], exclusiveMaximum: 5 }, minLength: 2 });
    expect(schema.nullable).toBe(true);
    expect(schema.anyOf).toEqual([
      { type: "string", description: expect.stringContaining("minLength: 2") },
      { type: "array", items: { type: "number", nullable: true, description: expect.stringContaining("exclusiveMaximum: 5") } },
    ]);
  });

  it("merges allOf object requirements and preserves oneOf alternatives", () => {
    const schema = normalize(reaTool.function.parameters);
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.view).toMatchObject({ type: "object", required: ["kind", "limit"], properties: { kind: { type: "string", enum: ["page", "native"] }, offset: { type: "integer", default: 0 }, limit: { type: "integer" } } });
    expect(properties.source.anyOf).toHaveLength(2);
    expect(properties.source.description).toContain("exactly one");
  });

  it("handles boolean schemas in schema slots without changing literal data", () => {
    const literal = { exclusiveMinimum: 0, "x-mcp-header": false, nested: [true, false, { $ref: "literal" }] };
    const schema = normalize({ type: "object", properties: { open: true, closed: false, list: { type: "array", items: false }, literal: { default: literal, example: literal } }, additionalProperties: false });
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.open).toEqual({});
    expect(properties.closed.description).toContain("no value is permitted");
    expect(properties.list.items).toMatchObject({ description: expect.stringContaining("no value is permitted") });
    expect(properties.literal).toEqual({ default: literal, example: literal });
    expect(schema.description).toContain("additionalProperties: false");
  });

  it("removes impossible union branches and does not narrow a union with true", () => {
    expect(normalize({ anyOf: [false, { type: "string" }] })).toEqual({ type: "string" });
    expect(normalize({ anyOf: [true, { type: "string" }] })).toEqual({});
    expect(normalize({ anyOf: [false, false] }).description).toContain("no value is permitted");
    expect(normalize({ type: "null" })).toMatchObject({ nullable: true, description: expect.stringContaining("null") });
    expect(normalize({ anyOf: [{ nullable: true }, { type: "string" }] }).anyOf).toHaveLength(2);
    expect(normalize({ oneOf: [true, true] }).description).toContain("no value is permitted");
    expect(normalize({ allOf: [{ type: "null" }, { type: "string" }] }).description).toContain("no value is permitted");
  });

  it("preserves nullable enum alternatives rather than collapsing them to null-only", () => {
    const schema = normalize({ anyOf: [{ enum: ["a", null] }, { type: "integer" }] });
    expect(schema.anyOf).toHaveLength(2);
    expect(JSON.stringify(schema)).toContain('enum: [\\"a\\",null]');
  });

  it("merges repeated property intersections without widening enums or requirements", () => {
    const schema = normalize({ allOf: [
      { type: "object", properties: { mode: { enum: ["a", "b"] }, count: { type: "number", minimum: 0 } }, required: ["mode"] },
      { type: "object", properties: { mode: { enum: ["b", "c"] }, count: { type: "integer", exclusiveMaximum: 10 } }, required: ["count"] },
    ] });
    expect(schema).toMatchObject({ type: "object", required: ["mode", "count"], properties: { mode: { type: "string", enum: ["b"] }, count: { type: "integer" } } });
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.count.description).toContain("minimum: 0");
    expect(properties.count.description).toContain("exclusiveMaximum: 10");
  });

  it("keeps independent unions as intersections and handles legacy bounds and tuple items", () => {
    const schema = normalize({ allOf: [{ anyOf: [{ type: "string" }, { type: "integer" }] }, { anyOf: [{ type: "integer" }, { type: "boolean" }] }] });
    expect(schema.anyOf).toHaveLength(2);
    expect(schema.description).toContain("allOf");
    expect(normalize({ type: "number", minimum: 0, exclusiveMinimum: true }).description).toContain("exclusiveMinimum: true");
    const tuple = normalize({ type: "array", items: [{ type: "number", exclusiveMinimum: 0 }, { type: "string" }], additionalItems: false });
    expect(tuple.items).toEqual({});
    expect(tuple.description).toContain("items:");
    expect(tuple.description).toContain("additionalItems: false");
  });

  it("normalizes snake-case fields without renaming arbitrary property names", () => {
    const schema = normalize({ type: "object", additional_properties: false, properties: { any_of: { any_of: [{ type: "string" }, { type: "null" }] }, property_ordering: { type: "string" } }, property_ordering: ["any_of", "property_ordering"] });
    expect(Object.keys(schema.properties as object)).toEqual(["any_of", "property_ordering"]);
    expect(schema.propertyOrdering).toEqual(["any_of", "property_ordering"]);
    expect((schema.properties as Record<string, unknown>).any_of).toEqual({ type: "string", nullable: true });
    expect(schema.description).toContain("additionalProperties: false");
  });

  it("resolves escaped, array and root pointers and keeps ref siblings independent of key order", () => {
    const defs = { "a/b~c": { type: "string", minLength: 2 }, disabled: false };
    const schema = normalize({ type: "object", $defs: defs, allOf: [{ properties: { fromArray: { type: "integer" } } }], properties: { first: { $ref: "#/$defs/a~1b~0c", description: "First" }, second: { description: "Second", $ref: "#/$defs/a~1b~0c" }, disabled: { $ref: "#/$defs/disabled" }, array: { $ref: "#/allOf/0/properties/fromArray" }, recursive: { $ref: "#" } } });
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    for (const name of ["first", "second"]) expect(properties[name]).toMatchObject({ type: "string", description: expect.stringContaining("minLength: 2") });
    expect(properties.first.description).toContain("First");
    expect(properties.second.description).toContain("Second");
    expect(properties.disabled.description).toContain("no value is permitted");
    expect(properties.array).toEqual({ type: "integer" });
    expect(JSON.stringify(schema)).toContain("Recursive");
  });

  it("does not resolve inherited pointers or silently lose missing references", () => {
    const schema = normalize({ type: "object", properties: { missing: { $ref: "#/constructor" }, external: { $ref: "https://example.test/schema" } } });
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.missing.description).toContain("Unresolved");
    expect(properties.external.description).toContain("https://example.test/schema");
  });

  it("retains non-string enum/const constraints without emitting invalid enum values", () => {
    expect(normalize({ const: "fixed" })).toEqual({ type: "string", enum: ["fixed"] });
    expect(normalize({ type: "integer", const: 3 }).description).toContain("const: 3");
    expect(normalize({ enum: [true, false] })).toMatchObject({ type: "boolean", description: expect.stringContaining("enum: [true,false]") });
    expect(normalize({ enum: [{ type: "literal", exclusiveMinimum: 0 }] }).description).toContain('"exclusiveMinimum":0');
  });

  it("annotates unrepresentable composition, tuple and dependent constraints", () => {
    const schema = normalize({ type: "array", prefixItems: [{ type: "integer", exclusiveMinimum: 0 }, { type: "string" }], items: false, not: { maxItems: 0 }, if: { minItems: 2 }, then: { maxItems: 2 }, else: { minItems: 1 }, dependentRequired: { a: ["b"] }, "x-unrecognized-extension": "ignored" });
    for (const keyword of ["prefixItems", "not", "if", "then", "else"]) expect(schema.description).toContain(keyword);
    expect(normalize({ type: "object", dependentRequired: { a: ["b"] } }).description).toContain("dependentRequired");
  });

  it("terminates recursive schemas while normalizing shared subtrees at every occurrence", () => {
    const child = { type: "number", exclusiveMinimum: 0 };
    const cyclic: Record<string, unknown> = { type: "object", properties: { a: child, b: child } };
    (cyclic.properties as Record<string, unknown>).self = cyclic;
    const schema = normalize(cyclic);
    const properties = schema.properties as Record<string, unknown>;
    expect(properties.a).toEqual(properties.b);
    expect(() => JSON.stringify(schema)).not.toThrow();
  });

  it("preserves named tool selection, forced mode and the original tool definitions", () => {
    const plan = planToolCall({ tools: [openCodeTool, reaTool], toolChoice: { type: "function", function: { name: reaTool.function.name } } });
    expect(plan.tools![0].functionDeclarations.map(tool => tool.name)).toEqual([reaTool.function.name]);
    expect(plan.toolConfig?.functionCallingConfig).toEqual({ mode: "ANY", allowedFunctionNames: [reaTool.function.name] });
    assertToolWireSchema(plan.tools![0].functionDeclarations[0].parameters);
  });

  it("keeps OAuth, model routing, signed calls, results and streamed tool calls unchanged on the wire", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls++;
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("gemini-3.8-flash-tiered");
      expect(body.request.tools[0].functionDeclarations.map((fn: { name: string }) => fn.name)).toEqual([openCodeTool.function.name, reaTool.function.name]);
      for (const fn of body.request.tools[0].functionDeclarations) assertToolWireSchema(fn.parameters);
      if (calls === 2) {
        expect(body.request.contents[1].parts[0]).toMatchObject({ thoughtSignature: "signature", functionCall: { name: "bash", id: "call_prior", args: { command: "pwd" } } });
        expect(body.request.contents[2].parts[0]).toMatchObject({ functionResponse: { name: "bash", id: "call_prior", response: { output: "workspace" } } });
      }
      const functionCall = calls === 1 ? { id: "call_prior", name: "bash", args: { command: "pwd" } } : { id: "call_next", name: "bash", args: { command: "ls" } };
      const event = { response: { candidates: [{ content: { parts: [{ functionCall, thoughtSignature: calls === 1 ? "signature" : "next-signature" }] }, finishReason: "STOP" }] } };
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`)); controller.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
    });
    const provider = new AntigravityProvider({ accessToken: "test-token", projectId: "test-project" }, { fetch: fetchImpl as typeof fetch });
    for await (const _event of provider.chat({ model: "client-alias", requestId: "schema-wire-first", stream: true, tools: [openCodeTool, reaTool], messages: [{ role: "user", content: "Inspect the project" }] })) { /* drain the signed call */ }
    const events = [];
    for await (const event of provider.chat({ model: "client-alias", requestId: "schema-wire", stream: true, tools: [openCodeTool, reaTool], messages: [
      { role: "user", content: "Inspect the project" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_prior", type: "function", function: { name: "bash", arguments: '{"command":"pwd"}' } }] },
      { role: "tool", tool_call_id: "call_prior", content: "workspace" },
    ] })) events.push(event);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_call_delta", id: "call_next", name: "bash", argumentsDelta: '{"command":"ls"}' }));
    expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "tool_calls" });
  });
});
