import { describe, expect, it } from "vitest";
import {
  MAX_RESPONSE_SCHEMA_DEPTH,
  ResponseSchemaError,
  toGeminiSchema,
} from "../../src/providers/json-schema";

describe("toGeminiSchema", () => {
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
