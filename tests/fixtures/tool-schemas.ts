import type { ToolDefinition } from "../../src/types/provider";

// Representative client schemas, not captured user configuration or live credentials.
export const openCodeTool: ToolDefinition = {
  type: "function",
  function: {
    name: "bash",
    description: "Execute a shell command.",
    parameters: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        command: { type: "string", minLength: 1 },
        timeout: { type: "number", description: "Timeout in milliseconds", exclusiveMinimum: 0, exclusiveMaximum: 600000, multipleOf: 1 },
        description: { type: "string", maxLength: 80 },
        session: { anyOf: [{ $ref: "#/$defs/Session" }, { type: "null" }] },
      },
      required: ["command", "description"],
      additionalProperties: false,
      $defs: { Session: { type: "string", "x-mcp-header": "Session-Id", pattern: "^[a-z]+$" } },
    },
  },
};

// Based on REA inspect_analysis_view's exposed source/view discriminated unions.
// Bounds, nullable slots and keyword-like names exercise common MCP schema emitters.
export const reaTool: ToolDefinition = {
  type: "function",
  function: {
    name: "mcp__rea__inspect_analysis_view",
    parameters: {
      type: "object",
      properties: {
        source: { oneOf: [
          { type: "object", properties: { kind: { const: "retained-evidence" }, evidence_id: { type: "string" } }, required: ["kind", "evidence_id"] },
          { type: "object", properties: { kind: { const: "inline" }, evidence: true }, required: ["kind", "evidence"] },
        ] },
        view: { $ref: "#/definitions/View" },
        selectors: { type: "array", items: { anyOf: [{ type: "string", minLength: 1 }, { type: "integer", minimum: 0 }] }, uniqueItems: true },
        options: { type: ["object", "null"], properties: { exclusiveMinimum: { type: "number", exclusiveMinimum: 0 }, "x-mcp-header": { type: "string", "x-mcp-header": "Request-Id" }, forbidden: false } },
      },
      required: ["source", "view"],
      definitions: { View: { allOf: [
        { type: "object", properties: { kind: { enum: ["page", "native"] }, offset: { type: "integer", minimum: 0, default: 0 } }, required: ["kind"] },
        { type: "object", properties: { limit: { type: "integer", exclusiveMinimum: 0, maximum: 1024 } }, required: ["limit"] },
      ] } },
    },
  },
};

// Test-side protocol contract; deliberately independent of the implementation's key set.
const wireFields = new Set(["type", "title", "description", "nullable", "enum", "properties", "required", "items", "anyOf", "propertyOrdering", "default", "example"]);
export function assertToolWireSchema(schema: unknown): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("Schema must be an object");
  const node = schema as Record<string, unknown>;
  for (const key of Object.keys(node)) if (!wireFields.has(key)) throw new Error(`Unknown schema field: ${key}`);
  if (node.type !== undefined && !["object", "array", "string", "integer", "number", "boolean"].includes(String(node.type))) throw new Error("Expected scalar, non-null type");
  if (node.enum !== undefined && (!Array.isArray(node.enum) || !node.enum.length || !node.enum.every(value => typeof value === "string"))) throw new Error("Expected nonempty string enum");
  if (node.properties) for (const child of Object.values(node.properties)) assertToolWireSchema(child);
  if (node.items !== undefined) assertToolWireSchema(node.items);
  if (node.anyOf !== undefined) {
    if (!Array.isArray(node.anyOf) || !node.anyOf.length) throw new Error("Expected nonempty anyOf");
    node.anyOf.forEach(assertToolWireSchema);
  }
}
