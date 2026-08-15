// Validates the deliberately small, closed JSON-Schema dialect used by provider Resources.
import type { JsonObject, JsonValue } from "../domain/json.js";

export interface SchemaValidationIssue {
  readonly message: string;
  readonly path: string;
}

const COMMON_KEYS = new Set(["$schema", "allOf", "anyOf", "const", "description", "enum", "oneOf", "title", "type"]);
const TYPE_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  array: new Set(["items", "maxItems", "minItems", "uniqueItems"]), boolean: new Set(),
  integer: new Set(["maximum", "minimum"]), null: new Set(), number: new Set(["maximum", "minimum"]),
  object: new Set(["additionalProperties", "maxProperties", "minProperties", "properties", "required"]),
  string: new Set(["maxLength", "minLength", "pattern"]),
};

export function assertSupportedJsonSchema(schema: JsonObject, label = "JSON Schema"): void {
  assertSchemaNode(schema, "$", label);
}

export function validateJsonSchemaValue(schema: JsonObject, value: JsonValue): readonly SchemaValidationIssue[] {
  const issues: SchemaValidationIssue[] = [];
  validateNode(schema, value, "$", issues);
  return issues;
}

function assertSchemaNode(schema: JsonObject, path: string, label: string): void {
  const type = schema.type;
  if (type !== undefined && (typeof type !== "string" || !(type in TYPE_KEYS))) throw new TypeError(`${label} ${path}.type is unsupported`);
  const allowed = new Set(COMMON_KEYS);
  if (typeof type === "string") for (const key of TYPE_KEYS[type] ?? []) allowed.add(key);
  for (const key of Object.keys(schema)) if (!allowed.has(key)) throw new TypeError(`${label} ${path}.${key} is unsupported`);
  if ("$schema" in schema && typeof schema.$schema !== "string") throw new TypeError(`${label} ${path}.$schema must be a string`);
  if ("description" in schema && typeof schema.description !== "string" || "title" in schema && typeof schema.title !== "string") throw new TypeError(`${label} ${path} annotations must be strings`);
  if ("enum" in schema && (!Array.isArray(schema.enum) || schema.enum.length === 0)) throw new TypeError(`${label} ${path}.enum must be a non-empty array`);
  for (const branch of ["allOf", "anyOf", "oneOf"] as const) {
    const value = schema[branch];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length === 0 || value.some((item) => !isObject(item))) throw new TypeError(`${label} ${path}.${branch} must contain schema objects`);
    value.forEach((item, index) => assertSchemaNode(item as JsonObject, `${path}.${branch}[${index}]`, label));
  }
  if (type === "object") assertObjectSchema(schema, path, label);
  if (type === "array") {
    if (!isObject(schema.items)) throw new TypeError(`${label} ${path}.items must be a schema object`);
    assertSchemaNode(schema.items, `${path}.items`, label);
    assertNonNegativeInteger(schema.minItems, `${label} ${path}.minItems`);
    assertNonNegativeInteger(schema.maxItems, `${label} ${path}.maxItems`);
    if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") throw new TypeError(`${label} ${path}.uniqueItems must be boolean`);
  }
  if (type === "string") {
    assertNonNegativeInteger(schema.minLength, `${label} ${path}.minLength`);
    assertNonNegativeInteger(schema.maxLength, `${label} ${path}.maxLength`);
    if (schema.pattern !== undefined) {
      if (typeof schema.pattern !== "string") throw new TypeError(`${label} ${path}.pattern must be a string`);
      try { new RegExp(schema.pattern, "u"); } catch { throw new TypeError(`${label} ${path}.pattern is invalid`); }
    }
  }
  if (type === "number" || type === "integer") for (const key of ["minimum", "maximum"] as const) {
    const value = schema[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) throw new TypeError(`${label} ${path}.${key} must be finite`);
  }
}

function assertObjectSchema(schema: JsonObject, path: string, label: string): void {
  if (schema.additionalProperties !== false) throw new TypeError(`${label} ${path} must set additionalProperties to false`);
  if (!isObject(schema.properties)) throw new TypeError(`${label} ${path}.properties must be an object`);
  for (const [key, child] of Object.entries(schema.properties)) {
    if (!isObject(child)) throw new TypeError(`${label} ${path}.properties.${key} must be a schema object`);
    assertSchemaNode(child, `${path}.properties.${key}`, label);
  }
  if (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== "string") || new Set(schema.required).size !== schema.required.length) throw new TypeError(`${label} ${path}.required must contain unique strings`);
  for (const key of schema.required as string[]) if (!(key in schema.properties)) throw new TypeError(`${label} ${path}.required names an unknown property: ${key}`);
  assertNonNegativeInteger(schema.minProperties, `${label} ${path}.minProperties`);
  assertNonNegativeInteger(schema.maxProperties, `${label} ${path}.maxProperties`);
}

function assertNonNegativeInteger(value: JsonValue | undefined, label: string): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
}

function validateNode(schema: JsonObject, value: JsonValue, path: string, issues: SchemaValidationIssue[]): void {
  if ("const" in schema && !sameJson(schema.const, value)) issues.push({ message: "does not equal the required constant", path });
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => sameJson(candidate, value))) issues.push({ message: "is not an allowed enum value", path });
  const type = schema.type;
  if (typeof type === "string" && !matchesType(type, value)) { issues.push({ message: `must have type ${type}`, path }); return; }
  if (type === "object" && isObject(value)) validateObject(schema, value, path, issues);
  if (type === "array" && Array.isArray(value)) validateArray(schema, value, path, issues);
  if (type === "string" && typeof value === "string") validateString(schema, value, path, issues);
  if ((type === "number" || type === "integer") && typeof value === "number") validateNumber(schema, value, path, issues);
  for (const key of ["allOf", "anyOf", "oneOf"] as const) validateBranches(key, schema[key], value, path, issues);
}

function validateObject(schema: JsonObject, value: JsonObject, path: string, issues: SchemaValidationIssue[]): void {
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required as string[] : [];
  if (typeof schema.minProperties === "number" && Object.keys(value).length < schema.minProperties) issues.push({ message: `must contain at least ${schema.minProperties} properties`, path });
  if (typeof schema.maxProperties === "number" && Object.keys(value).length > schema.maxProperties) issues.push({ message: `must contain at most ${schema.maxProperties} properties`, path });
  for (const name of required) if (!(name in value)) issues.push({ message: "is required", path: `${path}.${name}` });
  for (const [name, child] of Object.entries(value)) {
    const childSchema = properties[name];
    if (childSchema === undefined) { if (schema.additionalProperties === false) issues.push({ message: "is not allowed", path: `${path}.${name}` }); continue; }
    validateNode(childSchema as JsonObject, child, `${path}.${name}`, issues);
  }
}

function validateArray(schema: JsonObject, value: readonly JsonValue[], path: string, issues: SchemaValidationIssue[]): void {
  if (typeof schema.minItems === "number" && value.length < schema.minItems) issues.push({ message: `must contain at least ${schema.minItems} items`, path });
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) issues.push({ message: `must contain at most ${schema.maxItems} items`, path });
  if (schema.uniqueItems === true) { const keys = value.map((item) => JSON.stringify(item)); if (new Set(keys).size !== keys.length) issues.push({ message: "must contain unique items", path }); }
  if (isObject(schema.items)) value.forEach((item, index) => validateNode(schema.items as JsonObject, item, `${path}[${index}]`, issues));
}

function validateString(schema: JsonObject, value: string, path: string, issues: SchemaValidationIssue[]): void {
  if (typeof schema.minLength === "number" && value.length < schema.minLength) issues.push({ message: `must be at least ${schema.minLength} characters`, path });
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) issues.push({ message: `must be at most ${schema.maxLength} characters`, path });
  if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) issues.push({ message: "does not match its pattern", path });
}

function validateNumber(schema: JsonObject, value: number, path: string, issues: SchemaValidationIssue[]): void {
  if (schema.type === "integer" && !Number.isSafeInteger(value)) issues.push({ message: "must be a safe integer", path });
  if (typeof schema.minimum === "number" && value < schema.minimum) issues.push({ message: `must be at least ${schema.minimum}`, path });
  if (typeof schema.maximum === "number" && value > schema.maximum) issues.push({ message: `must be at most ${schema.maximum}`, path });
}

function validateBranches(kind: "allOf" | "anyOf" | "oneOf", raw: JsonValue | undefined, value: JsonValue, path: string, issues: SchemaValidationIssue[]): void {
  if (!Array.isArray(raw)) return;
  const branchIssues = raw.map((branch) => { const found: SchemaValidationIssue[] = []; validateNode(branch as JsonObject, value, path, found); return found; });
  const successes = branchIssues.filter((found) => found.length === 0).length;
  if (kind === "allOf" && successes !== raw.length || kind === "anyOf" && successes === 0 || kind === "oneOf" && successes !== 1) issues.push({ message: `does not satisfy ${kind}`, path });
}

function matchesType(type: string, value: JsonValue): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isObject(value);
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  return typeof value === type;
}
function isObject(value: JsonValue | undefined): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
function sameJson(left: JsonValue | undefined, right: JsonValue): boolean { return JSON.stringify(left) === JSON.stringify(right); }
