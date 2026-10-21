/**
 * JSON Schema handling for the Antigravity / Cloud Code Assist wire format.
 *
 * Two targets, two dialects:
 *  - tool declarations accept a JSON Schema, but the Cloud Code Assist schema
 *    proto rejects unknown keywords ("Cannot find field"), so the schema is
 *    sanitized (see `sanitizeSchemaForCca`);
 *  - structured output uses the Gemini `responseSchema` proto, which expects
 *    UPPERCASE type names and a small field whitelist (see `toGeminiSchema`).
 *
 * Live-verified 2026-10-22: a `responseSchema` with lowercase types is
 * accepted by the backend but silently IGNORED (the model answers with an
 * arbitrary shape), while uppercase types are enforced.
 */

/** Resolve a local JSON pointer (`#/$defs/Thing`) against the schema root. */
export function resolveLocalRef(
  root: unknown,
  ref: string,
): unknown | undefined {
  if (!ref.startsWith("#/")) return undefined;
  const segments = ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = root;
  for (const segment of segments) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
    if (current === undefined) return undefined;
  }
  return current;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * JSON-Schema keywords the Cloud Code Assist schema proto rejects
 * ("Cannot find field" / INVALID_ARGUMENT). Mirrors OMP's
 * CCA_UNSUPPORTED_SCHEMA_FIELDS plus `const`, which OMP adds for CCA.
 */
const CCA_UNSUPPORTED_SCHEMA_KEYS = new Set([
  "$schema",
  "$id",
  "$anchor",
  "$ref",
  "$defs",
  "$dynamicRef",
  "$dynamicAnchor",
  "propertyNames",
  "deprecated",
  "readOnly",
  "writeOnly",
  "$comment",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "additionalItems",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
  "const",
]);

/** Guard against pathological or recursive schemas. */
const MAX_SCHEMA_DEPTH = 12;

/**
 * Make a client-supplied JSON Schema acceptable to Cloud Code Assist:
 * inline local `$ref`s, then drop every keyword the schema proto rejects.
 * Unknown-but-harmless keywords are preserved so the model still sees the
 * constraints the client intended.
 */
export function sanitizeSchemaForCca(
  schema: unknown,
  root: unknown = schema,
  depth = 0,
  expanding: ReadonlySet<string> = new Set(),
): unknown {
  if (depth > MAX_SCHEMA_DEPTH) return {};
  if (Array.isArray(schema)) {
    return schema.map((entry) =>
      sanitizeSchemaForCca(entry, root, depth + 1, expanding),
    );
  }
  if (!isPlainObject(schema)) return schema;

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$ref") {
      if (typeof value !== "string") continue;
      const resolved = resolveLocalRef(root, value);
      if (resolved === undefined) {
        // Unresolvable reference: dropping the (forbidden) $ref key leaves an
        // empty schema, which keeps the request valid instead of failing the
        // whole call with INVALID_ARGUMENT.
        continue;
      }
      if (expanding.has(value)) {
        continue;
      }
      const nextExpanding = new Set(expanding);
      nextExpanding.add(value);
      const inlined = sanitizeSchemaForCca(
        resolved,
        root,
        depth + 1,
        nextExpanding,
      );
      if (isPlainObject(inlined)) {
        Object.assign(output, inlined);
        continue;
      }
      continue;
    }
    if (CCA_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    output[key] = sanitizeSchemaForCca(value, root, depth + 1, expanding);
  }
  return output;
}

/** JSON Schema type name -> Gemini Schema type name. */
const GEMINI_TYPES: Record<string, string> = {
  string: "STRING",
  number: "NUMBER",
  integer: "INTEGER",
  boolean: "BOOLEAN",
  array: "ARRAY",
  object: "OBJECT",
  null: "NULL",
};

/**
 * Fields the Gemini Schema proto understands. Anything else is dropped —
 * protojson rejects unknown fields with INVALID_ARGUMENT.
 */
const GEMINI_SCHEMA_FIELDS = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "maxItems",
  "minItems",
  "properties",
  "required",
  "minProperties",
  "maxProperties",
  "minLength",
  "maxLength",
  "pattern",
  "example",
  "anyOf",
  "propertyOrdering",
  "default",
  "items",
  "minimum",
  "maximum",
]);

/** The backend accepts at most this many levels of nesting in a response schema. */
export const MAX_RESPONSE_SCHEMA_DEPTH = 5;

export class ResponseSchemaError extends Error {}

/**
 * Convert a client JSON Schema into a Gemini `responseSchema`.
 *
 * - type names become uppercase (`string` -> `STRING`);
 * - `type: ["string","null"]` becomes `type: "STRING", nullable: true`;
 * - `const` becomes a single-value `enum`;
 * - local `$ref`s are inlined;
 * - fields outside the Gemini Schema proto are dropped.
 */
export function toGeminiSchema(
  schema: unknown,
  root: unknown = schema,
  depth = 1,
  expanding: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  if (depth > MAX_RESPONSE_SCHEMA_DEPTH) {
    throw new ResponseSchemaError(
      `response_format schema nests deeper than ${MAX_RESPONSE_SCHEMA_DEPTH} levels, which the provider does not support.`,
    );
  }
  if (!isPlainObject(schema)) {
    throw new ResponseSchemaError(
      "response_format schema must be a JSON Schema object.",
    );
  }

  const output: Record<string, unknown> = {};
  let nullable = false;

  for (const [key, value] of Object.entries(schema)) {
    if (key === "$ref") {
      if (typeof value !== "string") continue;
      const resolved = resolveLocalRef(root, value);
      if (resolved === undefined || expanding.has(value)) continue;
      const nextExpanding = new Set(expanding);
      nextExpanding.add(value);
      const inlined = toGeminiSchema(resolved, root, depth, nextExpanding);
      Object.assign(output, inlined);
      continue;
    }
    if (key === "type") {
      if (typeof value === "string") {
        const mapped = GEMINI_TYPES[value.toLowerCase()];
        if (!mapped) {
          throw new ResponseSchemaError(
            `response_format schema uses an unsupported type '${value}'.`,
          );
        }
        output.type = mapped;
        continue;
      }
      if (Array.isArray(value)) {
        const types = value.filter(
          (entry): entry is string => typeof entry === "string",
        );
        const concrete = types.filter(
          (entry) => entry.toLowerCase() !== "null",
        );
        if (types.some((entry) => entry.toLowerCase() === "null")) {
          nullable = true;
        }
        const primary = concrete[0];
        if (!primary) {
          throw new ResponseSchemaError(
            "response_format schema has a type list without a concrete type.",
          );
        }
        const mapped = GEMINI_TYPES[primary.toLowerCase()];
        if (!mapped) {
          throw new ResponseSchemaError(
            `response_format schema uses an unsupported type '${primary}'.`,
          );
        }
        output.type = mapped;
        continue;
      }
      continue;
    }
    if (key === "const") {
      // Gemini has no `const`; express it as a single-value enum.
      output.enum = [value];
      continue;
    }
    if (!GEMINI_SCHEMA_FIELDS.has(key)) continue;
    if (key === "properties" && isPlainObject(value)) {
      const properties: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(value)) {
        properties[name] = toGeminiSchema(
          child,
          root,
          depth + 1,
          expanding,
        );
      }
      output.properties = properties;
      continue;
    }
    if (key === "items") {
      output.items = toGeminiSchema(value, root, depth + 1, expanding);
      continue;
    }
    if (key === "anyOf" && Array.isArray(value)) {
      output.anyOf = value.map((entry) =>
        toGeminiSchema(entry, root, depth + 1, expanding),
      );
      continue;
    }
    output[key] = value;
  }

  if (nullable && output.type !== "NULL") {
    output.nullable = true;
  }
  if (output.type === "OBJECT" && !output.properties) {
    output.properties = {};
  }
  return output;
}
