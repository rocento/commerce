/** Numeric IDs are optional for pre-migration cached responses and historical snapshots. */
export type EntityResponse<T> = T extends (infer Row)[] ? EntityResponse<Row>[] : T extends object ? {
  [Key in keyof T as Key extends "entity_id" ? T[Key] extends number ? never : Key : Key]: EntityResponse<T[Key]>
} & (T extends { entity_id: number } ? { readonly entity_id?: number } : unknown) : T;

/** Keep server-assigned numeric IDs out of mutation bodies, preserving UUID references. */
export function entityInput<T extends object>(value: T): Omit<T, "entity_id"> {
  const record = value as T & { entity_id?: unknown };
  if (typeof record.entity_id !== "number") return value;
  const input = { ...record };
  delete input.entity_id;
  return input;
}
