// Internal wire compatibility only. Services retain all authorization/state checks.
type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const supported = new Set(["$ref", "type", "const", "enum", "anyOf", "properties", "required", "additionalProperties", "items", "minItems", "maxItems", "minLength", "maxLength", "pattern", "minimum", "maximum", "title", "description", "default"]);
function validate(value: unknown, schema: unknown, definitions: ObjectValue): boolean {
  if (!object(schema) || Object.keys(schema).some(key => !supported.has(key))) return false;
  if (typeof schema.$ref === "string") return schema.$ref.startsWith("#/$defs/") && validate(value, definitions[schema.$ref.slice(8)], definitions);
  if (Object.hasOwn(schema, "const") && value !== schema.const) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (Array.isArray(schema.anyOf)) return schema.anyOf.some(rule => validate(value, rule, definitions));
  switch (schema.type) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "number": case "integer": return typeof value === "number" && Number.isFinite(value) && (schema.type !== "integer" || Number.isSafeInteger(value)) && (typeof schema.minimum !== "number" || value >= schema.minimum) && (typeof schema.maximum !== "number" || value <= schema.maximum);
    case "string": return typeof value === "string" && (typeof schema.minLength !== "number" || [...value].length >= schema.minLength) && (typeof schema.maxLength !== "number" || [...value].length <= schema.maxLength) && (typeof schema.pattern !== "string" || new RegExp(schema.pattern, "u").test(value));
    case "array": return Array.isArray(value) && (typeof schema.minItems !== "number" || value.length >= schema.minItems) && (typeof schema.maxItems !== "number" || value.length <= schema.maxItems) && value.every(item => validate(item, schema.items, definitions));
    case "object": {
      if (!object(value) || !object(schema.properties) || schema.additionalProperties !== false) return false;
      const properties = schema.properties;
      return (!Array.isArray(schema.required) || schema.required.every(key => typeof key === "string" && Object.hasOwn(value, key))) && Object.entries(value).every(([key, item]) => Object.hasOwn(properties, key) && validate(item, properties[key], definitions));
    }
    default: return false;
  }
}
export function validatesCore(value: unknown, contract: string, schema: unknown): boolean {
  return object(schema) && object(schema.$defs) && Object.hasOwn(schema.$defs, contract) && validate(value, schema.$defs[contract], schema.$defs);
}
