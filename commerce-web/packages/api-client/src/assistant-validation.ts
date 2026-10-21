import { assistantSchemas } from "./assistant-schemas";
import type { components } from "./schema";
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function validates(value: unknown, schema: unknown): boolean {
  if (!object(schema)) return false;
  if (typeof schema.$ref === "string") return validates(value, assistantSchemas[schema.$ref.split("/").pop()!]);
  if (schema.nullable === true && value === null) return true;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (schema.type === "object") {
    if (!object(value) || !object(schema.properties)) return false;
    const properties = schema.properties;
    return (!Array.isArray(schema.required) || schema.required.every(k => typeof k === "string" && Object.hasOwn(value,k))) && Object.entries(value).every(([k,v]) => Object.hasOwn(properties,k) && validates(v,properties[k]));
  }
  if (schema.type === "array") return Array.isArray(value) && (typeof schema.minItems !== "number" || value.length >= schema.minItems) && (typeof schema.maxItems !== "number" || value.length <= schema.maxItems) && value.every(v => validates(v,schema.items));
  if (schema.type === "integer") return Number.isSafeInteger(value) && (typeof schema.minimum !== "number" || (value as number) >= schema.minimum) && (typeof schema.maximum !== "number" || (value as number) <= schema.maximum);
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "string") return typeof value === "string" && (typeof schema.maxLength !== "number" || value.length <= schema.maxLength) && (typeof schema.minLength !== "number" || value.length >= schema.minLength) && (typeof schema.pattern !== "string" || new RegExp(schema.pattern).test(value)) && (schema.format !== "uuid" || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value));
  return false;
}

export function parseAssistantFailure(value: unknown, reference?: string): components["schemas"]["AssistantFailure"] | undefined {
  if (!validates(value, assistantSchemas.AssistantFailure)) return undefined;
  const failure = value as components["schemas"]["AssistantFailure"];
  return reference && failure.request_reference !== reference ? undefined : failure;
}
