import type { AttributeDefinition } from "@commerce/api-client";

export type AttributeFacets = Record<string, Record<string, number>>;
export function readAttributeFilters(params: URLSearchParams): Record<string, unknown> {
  try {
    const value = JSON.parse(params.get("attributes") ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
export function selectedAttributeValues(value: unknown): string[] {
  return value === undefined || value === null ? [] : (Array.isArray(value) ? value : [value]).map(String);
}
/** Repeated checkbox values are alternatives; typed exact fields remain scalars. */
export function attributeFiltersFromForm(data: FormData): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  for (const key of new Set([...data.keys()].filter(key => key.startsWith("attr:")))) {
    const code = key.slice(5), type = String(data.get(`attr-type:${code}`));
    const values = [...new Set(data.getAll(key).map(String).filter(Boolean))].map(value =>
      ["integer", "decimal", "measurement"].includes(type) ? Number(value) : type === "boolean" ? value === "true" : value);
    if (values.length) attributes[code] = data.get(`attr-mode:${code}`) === "multiple" ? values : values[0];
  }
  return attributes;
}
export function attributeFilterOptions(d: AttributeDefinition, facets: AttributeFacets | undefined, selected: string[], yes: string, no: string) {
  const counts = facets?.[d.attribute_code];
  const options = d.input_type === "boolean" ? [{value:"true",label:yes},{value:"false",label:no}]
    : d.options.length ? d.options : Object.keys(counts ?? {}).map(value => ({value, label:value}));
  // Keep selected values removable even after a different filter gives no matches.
  const all = [...options, ...selected.filter(value => !options.some(o => o.value === value)).map(value => ({value,label:value}))];
  return all.filter(o => !d.metadata?.facetable || facets === undefined || (counts?.[o.value] ?? 0) > 0 || selected.includes(o.value))
    .map(o => ({...o, count: d.metadata?.facetable && facets !== undefined ? counts?.[o.value] ?? 0 : undefined}));
}
export function removeAttributeFilter(params: URLSearchParams, code: string, value: string): URLSearchParams {
  const next = new URLSearchParams(params), attributes = readAttributeFilters(params);
  if (Array.isArray(attributes[code])) {
    const remaining = (attributes[code] as unknown[]).filter(v => String(v) !== value);
    if (remaining.length) attributes[code] = remaining; else delete attributes[code];
  } else delete attributes[code];
  if (Object.keys(attributes).length) next.set("attributes", JSON.stringify(attributes)); else next.delete("attributes");
  next.delete("offset");
  return next;
}
