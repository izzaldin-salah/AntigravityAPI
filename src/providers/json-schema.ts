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
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let pointer: string;
  try { pointer = decodeURIComponent(ref.slice(2)); } catch { return undefined; }
  const segments = pointer
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = root;
  for (const segment of segments) {
    if ((!isPlainObject(current) && !Array.isArray(current)) || !Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
    if (current === undefined) return undefined;
  }
  return current;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Conservative Google/Cloud Code Assist Schema wire subset. Unknown fields
 * are rejected by protojson, so a denylist cannot safely cover MCP extensions.
 * Reference: Oh My Pi 0b5c27ab, utils/schema/{normalize,fields,spill}.ts (MIT).
 * See docs/tool-schema-compatibility.md for the pinned sources and tradeoffs.
 */
const CCA_SCHEMA_FIELDS = new Set([
  "type", "title", "description", "nullable", "enum", "properties", "required",
  "items", "anyOf", "propertyOrdering", "default", "example",
]);
const DESCRIPTION_CONSTRAINTS = new Set([
  "pattern", "format", "minLength", "maxLength", "minimum", "maximum",
  "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems",
  "uniqueItems", "minProperties", "maxProperties", "examples", "additionalProperties",
  "patternProperties", "propertyNames", "prefixItems", "additionalItems",
  "unevaluatedProperties", "unevaluatedItems", "contains", "minContains", "maxContains",
  "dependencies", "dependentRequired", "dependentSchemas", "not", "if", "then", "else",
  "contentEncoding", "contentMediaType", "contentSchema", "$dynamicRef",
]);
const TYPE_FIELDS: Record<string, ReadonlySet<string>> = {
  string: new Set(["format", "pattern", "minLength", "maxLength", "contentEncoding", "contentMediaType"]),
  number: new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]),
  integer: new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]),
  object: new Set(["properties", "required", "propertyOrdering", "minProperties", "maxProperties", "additionalProperties", "patternProperties", "propertyNames", "dependencies", "dependentRequired", "dependentSchemas", "unevaluatedProperties"]),
  array: new Set(["items", "prefixItems", "additionalItems", "minItems", "maxItems", "uniqueItems", "contains", "minContains", "maxContains", "unevaluatedItems"]),
  boolean: new Set(),
};
const ALL_TYPE_FIELDS = new Set(Object.values(TYPE_FIELDS).flatMap(fields => [...fields]));

/** Guard against pathological or recursive schemas. */
const MAX_SCHEMA_DEPTH = 12;
const MAX_SCHEMA_NODES = 4096;
type SchemaNode = Record<string, unknown>;
type Projection = SchemaNode | false;
const nullOnlySchemas = new WeakSet<SchemaNode>();

function nullOnlySchema(): SchemaNode {
  const schema = { nullable: true, description: "Only null is permitted." };
  nullOnlySchemas.add(schema);
  return schema;
}

function addDescription(node: SchemaNode, text: string): void {
  node.description = node.description ? `${node.description}\n\n${text}` : text;
}

function describeConstraint(node: SchemaNode, key: string, value: unknown): void {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); } catch { encoded = '"[recursive schema]"'; }
  if (encoded !== undefined) addDescription(node, `{${key}: ${encoded}}`);
}

function wireNode(schema: Projection): SchemaNode {
  // The proto has no boolean schema or `not`. Keep impossibility explicit to
  // the model; execution-side validation remains the client's responsibility.
  return schema === false ? { description: "JSON Schema false: no value is permitted." } : schema;
}

function valueType(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

/** Intersect the representable parts of allOf/$ref siblings, never last-wins. */
function intersectSchemas(left: Projection, right: Projection): Projection {
  if (left === false || right === false) return false;
  if (nullOnlySchemas.has(left) || nullOnlySchemas.has(right)) {
    const other = nullOnlySchemas.has(left) ? right : left;
    if (other.nullable !== true && (other.type || other.enum || (Array.isArray(other.anyOf) && other.anyOf.every(branch => isPlainObject(branch) && branch.type && !branch.nullable)))) return false;
    const output = nullOnlySchema();
    for (const schema of [left, right]) if (schema.description && schema.description !== output.description) addDescription(output, String(schema.description));
    return output;
  }
  const output: SchemaNode = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (!Object.hasOwn(output, key)) { output[key] = value; continue; }
    const previous = output[key];
    if (key === "description") {
      if (previous !== value) addDescription(output, String(value));
    } else if (key === "properties" && isPlainObject(previous) && isPlainObject(value)) {
      const properties: SchemaNode = Object.assign(Object.create(null), previous);
      for (const [name, child] of Object.entries(value)) {
        properties[name] = Object.hasOwn(properties, name)
          ? wireNode(intersectSchemas(properties[name] as SchemaNode, child as SchemaNode)) : child;
      }
      output.properties = properties;
    } else if (key === "required" && Array.isArray(previous) && Array.isArray(value)) {
      output.required = [...new Set([...previous, ...value])];
    } else if (key === "items" && isPlainObject(previous) && isPlainObject(value)) {
      output.items = wireNode(intersectSchemas(previous, value));
    } else if (key === "enum" && Array.isArray(previous) && Array.isArray(value)) {
      const common = previous.filter(entry => value.includes(entry));
      if (!common.length) return false;
      output.enum = common;
    } else if (key === "type" && previous !== value) {
      if ([previous, value].every(type => type === "number" || type === "integer")) output.type = "integer";
      else if (left.nullable === true && right.nullable === true) return nullOnlySchema();
      else return false;
    } else if (key === "nullable") {
      output.nullable = previous === true && value === true;
    } else if (key === "anyOf") {
      // Two independent unions are an intersection, not a concatenated union.
      // Keep the first projection and describe the second rather than narrowing
      // to an arbitrarily chosen branch or expanding a Cartesian product.
      describeConstraint(output, "allOf", [{ anyOf: value }]);
    }
  }
  if (left.type && right.type && (left.nullable !== true || right.nullable !== true)) delete output.nullable;
  return output;
}

/**
 * Project tool parameters to the Google schema proto, retaining constraints
 * that cannot be encoded as description text. Only schema slots are walked:
 * property names and literal enum/default/example payloads are never keywords.
 * This is a wire-compatibility projection, not a JSON Schema validator.
 */
export function sanitizeSchemaForCca(
  schema: unknown,
  root: unknown = schema,
  depth = 0,
  expanding: ReadonlySet<string> = new Set(),
): SchemaNode {
  const visiting = new Set<object>();
  let remaining = MAX_SCHEMA_NODES;
  const walk = (input: unknown, level: number, refs: ReadonlySet<string>): Projection => {
    if (level > MAX_SCHEMA_DEPTH || --remaining < 0) return { description: "Schema expansion limit reached; validate the original tool schema." };
    if (input === false) return false;
    if (input === true) return {};
    if (!isPlainObject(input)) return {};
    if (visiting.has(input)) return { description: "Recursive schema; validate against the original tool schema." };
    visiting.add(input);
    try {
      // Snake-case aliases are schema fields only, never names in properties.
      const node = { ...input };
      for (const [from, to] of [["any_of", "anyOf"], ["additional_properties", "additionalProperties"], ["prefix_items", "prefixItems"], ["property_ordering", "propertyOrdering"]]) {
        if (Object.hasOwn(node, from)) { node[to] = node[from]; delete node[from]; }
      }
      let output: SchemaNode = {};
      for (const key of ["title", "description"]) if (typeof node[key] === "string") output[key] = node[key];

      const types = [...new Set((Array.isArray(node.type) ? node.type : [node.type]).filter((type): type is string => typeof type === "string"))];
      const nonNull = types.filter(type => type !== "null" && Object.hasOwn(TYPE_FIELDS, type));
      if (node.nullable === true || types.includes("null")) output.nullable = true;
      if (nonNull.length > 1) {
        output.anyOf = nonNull.map(type => {
          const branch = Object.fromEntries(Object.entries(node).filter(([key]) => ALL_TYPE_FIELDS.has(key) && TYPE_FIELDS[type].has(key)));
          return wireNode(walk({ ...branch, type }, level + 1, refs));
        });
      } else if (nonNull.length === 1) output.type = nonNull[0];
      else if (types.includes("null")) {
        addDescription(output, "Only null is permitted.");
        nullOnlySchemas.add(output);
      }
      else if (types.length) describeConstraint(output, "type", node.type);

      for (const [key, value] of Object.entries(node)) {
        if (["type", "title", "description", "nullable", "enum", "const", "$ref", "allOf", "anyOf", "oneOf"].includes(key)) continue;
        if (nonNull.length > 1 && ALL_TYPE_FIELDS.has(key)) continue;
        if (nullOnlySchemas.has(output) && ALL_TYPE_FIELDS.has(key)) continue;
        // JSON Schema ignores keywords belonging to a different explicit type.
        if (nonNull.length === 1 && ALL_TYPE_FIELDS.has(key) && !TYPE_FIELDS[nonNull[0]].has(key)) continue;
        if (key === "properties" && isPlainObject(value)) {
          output.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, wireNode(walk(child, level + 1, refs))]));
        } else if (key === "items") {
          if (Array.isArray(value) || Array.isArray(node.prefixItems)) {
            describeConstraint(output, "items", value);
            output.items = {}; // Tuple positions cannot be expressed as homogeneous items.
          } else output.items = wireNode(walk(value, level + 1, refs));
        } else if (key === "required" || key === "propertyOrdering") {
          if (Array.isArray(value)) output[key] = [...new Set(value.filter(entry => typeof entry === "string"))];
        } else if (CCA_SCHEMA_FIELDS.has(key)) {
          output[key] = value; // default/example are opaque instance data.
        } else if (DESCRIPTION_CONSTRAINTS.has(key)) describeConstraint(output, key, value);
      }

      const values = Object.hasOwn(node, "const") ? [node.const] : Array.isArray(node.enum) ? node.enum : undefined;
      if (values) {
        if (Object.hasOwn(node, "const") && Array.isArray(node.enum) && !node.enum.some(value => JSON.stringify(value) === JSON.stringify(node.const))) return false;
        if (!values.length) return false;
        if (values.every(value => value === null)) {
          if (output.type && output.nullable !== true) return false;
          output.nullable = true;
          addDescription(output, "Only null is permitted.");
          nullOnlySchemas.add(output);
        }
        if (!output.type && !output.anyOf) {
          const inferred = [...new Set(values.map(valueType))];
          if (inferred.length === 1 && Object.hasOwn(TYPE_FIELDS, inferred[0])) output.type = inferred[0];
        }
        if (values.every(value => typeof value === "string")) {
          if (output.type && output.type !== "string") return false;
          output.enum = [...new Set(values)];
        }
        else describeConstraint(output, Object.hasOwn(node, "const") ? "const" : "enum", Object.hasOwn(node, "const") ? node.const : values);
      }

      let combined: Projection = output;
      if (typeof node.$ref === "string") {
        const resolved = resolveLocalRef(root, node.$ref);
        if (resolved === undefined || refs.has(node.$ref)) addDescription(output, `${refs.has(node.$ref) ? "Recursive" : "Unresolved"} schema reference: ${node.$ref}`);
        else combined = intersectSchemas(walk(resolved, level + 1, new Set([...refs, node.$ref])), combined);
      }
      if (Array.isArray(node.allOf)) for (const branch of node.allOf) combined = intersectSchemas(combined, walk(branch, level + 1, refs));
      for (const combiner of ["anyOf", "oneOf"] as const) {
        if (!Array.isArray(node[combiner])) continue;
        const branches = node[combiner].map(branch => walk(branch, level + 1, refs)).filter((branch): branch is SchemaNode => branch !== false);
        let union: Projection;
        if (!branches.length) union = false;
        else if (combiner === "oneOf" && branches.filter(branch => Object.keys(branch).length === 0).length > 1) union = false;
        else if (branches.some(branch => Object.keys(branch).length === 0)) union = {};
        else {
          const nullBranches = branches.filter(branch => nullOnlySchemas.has(branch));
          const concrete = branches.filter(branch => !nullBranches.includes(branch));
          union = concrete.length === 1 ? { ...concrete[0] } : concrete.length ? { anyOf: concrete } : nullOnlySchema();
          if (nullBranches.length) union.nullable = true;
        }
        if (combiner === "oneOf" && union !== false) describeConstraint(union, "oneOf (exactly one alternative must match)", node.oneOf);
        combined = intersectSchemas(combined, union);
      }
      if (combined === false) return false;
      output = combined;
      if (nullOnlySchemas.has(output)) return output;
      if (typeof output.type === "string" && Object.hasOwn(TYPE_FIELDS, output.type)) {
        for (const key of Object.keys(output)) if (ALL_TYPE_FIELDS.has(key) && !TYPE_FIELDS[output.type].has(key)) delete output[key];
        if (output.enum && output.type !== "string") return false;
      }
      if (!output.type && !output.anyOf) {
        if (output.properties) output.type = "object";
        else if (output.items) output.type = "array";
      }
      if (output.type === "object" && !output.properties) output.properties = {};
      if (output.type === "array" && !output.items) output.items = {};
      return output;
    } finally { visiting.delete(input); }
  };
  return wireNode(walk(schema, depth, expanding));
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

  if (Array.isArray(schema.type)) {
    const types = [...new Set(schema.type)];
    if (types.length === 0 || types.some(type => typeof type !== "string" || !GEMINI_TYPES[type.toLowerCase()])) {
      throw new ResponseSchemaError("response_format schema contains an unsupported type union.");
    }
    const concrete = (types as string[]).filter(type => type.toLowerCase() !== "null");
    if (concrete.length > 1) {
      if (schema.anyOf !== undefined) {
        throw new ResponseSchemaError("Combining type unions with anyOf on the same schema node is unsupported.");
      }
      const typedFields: Record<string, string[]> = {
        string: ["minLength", "maxLength", "pattern", "format"],
        number: ["minimum", "maximum"], integer: ["minimum", "maximum"],
        object: ["properties", "required", "minProperties", "maxProperties", "propertyOrdering"],
        array: ["items", "minItems", "maxItems"],
      };
      const specific = new Set(Object.values(typedFields).flat());
      return {
        anyOf: concrete.map(type => {
          const branch = Object.fromEntries(Object.entries(schema).filter(([key]) =>
            key !== "type" && (!specific.has(key) || typedFields[type.toLowerCase()]?.includes(key))));
          return toGeminiSchema({...branch, type}, root, depth + 1, expanding);
        }),
        ...(concrete.length !== types.length ? {nullable: true} : {}),
      };
    }
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
      const properties: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
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
