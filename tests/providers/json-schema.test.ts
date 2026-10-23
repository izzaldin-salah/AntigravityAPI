import { describe, expect, it } from "vitest";
import {
  MAX_RESPONSE_SCHEMA_DEPTH,
  ResponseSchemaError,
  toGeminiSchema,
  sanitizeSchemaForCca,
} from "../../src/providers/json-schema";

describe("schema property maps", () => {
  it("preserves keyword-like names, references and literal default objects", () => {
    const schema = {
      type: "object", required: ["readOnly", "const", "$schema"],
      properties: {
        readOnly: { type: "string", readOnly: true },
        const: { $ref: "#/$defs/const" },
        $schema: { type: "object", properties: { const: { type: "integer" } } },
      },
      $defs: { const: { type: "string", default: { const: "literal", readOnly: "literal" } } },
    };
    const before = JSON.stringify(schema);
    expect(sanitizeSchemaForCca(schema)).toEqual({
      type: "object", required: schema.required,
      properties: {
        readOnly: { type: "string" },
        const: { type: "string", default: { const: "literal", readOnly: "literal" } },
        $schema: { type: "object", properties: { const: { type: "integer" } } },
      },
    });
    expect(JSON.stringify(schema)).toBe(before);
    expect(() => sanitizeSchemaForCca({properties:{const:{$ref:"#/$defs/R"}},$defs:{R:{$ref:"#/$defs/R"}}})).not.toThrow();
  });
});

describe("toGeminiSchema", () => {
  it("preserves prototype-like parameter names as own properties",()=>{
    const schema=JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"integer"}},"required":["__proto__","constructor"]}');
    const output=toGeminiSchema(schema);
    expect(Object.keys(output.properties as object)).toEqual(["__proto__","constructor"]);
    expect(JSON.stringify(output)).toContain('"__proto__":{"type":"STRING"}');
  });
  it("preserves all union branches and their applicable constraints", () => {
    expect(toGeminiSchema({type:["string","integer"],minLength:2,minimum:0})).toEqual({
      anyOf:[{type:"STRING",minLength:2},{type:"INTEGER",minimum:0}],
    });
    expect(toGeminiSchema({type:"object",properties:{value:{type:["string","integer","boolean","null"]}}})).toEqual({
      type:"OBJECT",properties:{value:{anyOf:[{type:"STRING"},{type:"INTEGER"},{type:"BOOLEAN"}],nullable:true}},
    });
    expect(() => toGeminiSchema({type:["string","date"]})).toThrow(ResponseSchemaError);
    expect(() => toGeminiSchema({type:["string",3]})).toThrow(ResponseSchemaError);
  });
  it("uppercases type names so the upstream enforces the schema", () => {
    const schema = toGeminiSchema({
      type: "object",
      properties: {
        capital: { type: "string", description: "City name" },
        population: { type: "integer" },
        ratio: { type: "number" },
        active: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["capital"],
    });

    expect(schema).toEqual({
      type: "OBJECT",
      properties: {
        capital: { type: "STRING", description: "City name" },
        population: { type: "INTEGER" },
        ratio: { type: "NUMBER" },
        active: { type: "BOOLEAN" },
        tags: { type: "ARRAY", items: { type: "STRING" } },
      },
      required: ["capital"],
    });
  });

  it("turns a nullable type union into a nullable schema", () => {
    const schema = toGeminiSchema({
      type: "object",
      properties: { nickname: { type: ["string", "null"] } },
    });

    expect(schema.properties).toEqual({
      nickname: { type: "STRING", nullable: true },
    });
  });

  it("expresses const as a single-value enum", () => {
    const schema = toGeminiSchema({ type: "string", const: "fixed" });
    expect(schema).toEqual({ type: "STRING", enum: ["fixed"] });
  });

  it("drops keywords the Gemini schema proto rejects", () => {
    const schema = toGeminiSchema({
      type: "object",
      $schema: "https://json-schema.org/draft/2020-12/schema",
      additionalProperties: false,
      properties: {
        name: { type: "string", pattern: "^[a-z]+$", minLength: 1 },
      },
    });

    expect(schema).not.toHaveProperty("$schema");
    expect(schema).not.toHaveProperty("additionalProperties");
    expect(schema.properties).toEqual({
      name: { type: "STRING", pattern: "^[a-z]+$", minLength: 1 },
    });
  });

  it("inlines local $ref pointers", () => {
    const schema = toGeminiSchema({
      type: "object",
      properties: { city: { $ref: "#/$defs/City" } },
      $defs: { City: { type: "object", properties: { name: { type: "string" } } } },
    });

    expect(schema.properties).toEqual({
      city: { type: "OBJECT", properties: { name: { type: "STRING" } } },
    });
  });

  it("rejects a schema nested deeper than the provider supports", () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < MAX_RESPONSE_SCHEMA_DEPTH + 1; i++) {
      schema = { type: "object", properties: { nested: schema } };
    }

    expect(() => toGeminiSchema(schema)).toThrow(ResponseSchemaError);
  });

  it("rejects an unsupported type", () => {
    expect(() => toGeminiSchema({ type: "date" })).toThrow(ResponseSchemaError);
  });
});
