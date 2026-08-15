// Validates the closed JSON-Schema subset accepted for agent result contracts.
import type { JsonObject, JsonValue } from "../domain/json.js";

export interface SchemaValidationIssue {
  readonly message: string;
  readonly path: string;
}

export function validateJsonSchemaValue(schema: JsonObject, value: JsonValue): readonly SchemaValidationIssue[] {
  const issues: SchemaValidationIssue[] = [];
  validateNode(schema, value, "$", issues);
  return issues;
}

function validateNode(schema: JsonObject, value: JsonValue, path: string, issues: SchemaValidationIssue[]): void {
  if ("const" in schema && !sameJson(schema.const, value)) issues.push({ message: "does not equal the required constant", path });
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => sameJson(candidate, value))) issues.push({ message: "is not an allowed enum value", path });
  const type = schema.type;
  if (typeof type === "string" && !matchesType(type, value)) {
    issues.push({ message: `must have type ${type}`, path });
    return;
  }
  if (type === "object" && isObject(value)) validateObject(schema, value, path, issues);
  if (type === "array" && Array.isArray(value)) validateArray(schema, value, path, issues);
  if (type === "string" && typeof value === "string") validateString(schema, value, path, issues);
  if ((type === "number" || type === "integer") && typeof value === "number") validateNumber(schema, value, path, issues);
  for (const key of ["allOf", "anyOf", "oneOf"] as const) validateBranches(key, schema[key], value, path, issues);
}

function validateObject(schema: JsonObject, value: JsonObject, path: string, issues: SchemaValidationIssue[]): void {
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
  for (const name of required) if (!(name in value)) issues.push({ message: "is required", path: `${path}.${name}` });
  for (const [name, child] of Object.entries(value)) {
    const childSchema = properties[name];
    if (childSchema === undefined) {
      if (schema.additionalProperties === false) issues.push({ message: "is not allowed", path: `${path}.${name}` });
      continue;
    }
    if (!isObject(childSchema)) issues.push({ message: "has an invalid schema", path: `${path}.${name}` });
    else validateNode(childSchema, child, `${path}.${name}`, issues);
  }
}

function validateArray(schema: JsonObject, value: readonly JsonValue[], path: string, issues: SchemaValidationIssue[]): void {
  if (typeof schema.minItems === "number" && value.length < schema.minItems) issues.push({ message: `must contain at least ${schema.minItems} items`, path });
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) issues.push({ message: `must contain at most ${schema.maxItems} items`, path });
  if (schema.uniqueItems === true) {
    const keys = value.map((item) => JSON.stringify(item));
    if (new Set(keys).size !== keys.length) issues.push({ message: "must contain unique items", path });
  }
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
  const branchIssues = raw.map((branch) => {
    const found: SchemaValidationIssue[] = [];
    if (!isObject(branch)) found.push({ message: "branch schema is invalid", path });
    else validateNode(branch, value, path, found);
    return found;
  });
  const successes = branchIssues.filter((found) => found.length === 0).length;
  if (kind === "allOf" && successes !== raw.length || kind === "anyOf" && successes === 0 || kind === "oneOf" && successes !== 1) {
    issues.push({ message: `does not satisfy ${kind}`, path });
  }
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
