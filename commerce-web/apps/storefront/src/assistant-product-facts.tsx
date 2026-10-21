export function attributeLabel(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
}

export function attributeValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined || value === '') return 'Not provided';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (depth < 4 && typeof value === 'string' && /^[\[{]/.test(value.trim())) {
    try { return attributeValue(JSON.parse(value), depth + 1); } catch { /* Plain catalog text. */ }
  }
  if (Array.isArray(value)) return value.length ? value.map(item => attributeValue(item, depth + 1)).join(', ') : 'Not provided';
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${attributeLabel(key)}: ${depth < 4 ? attributeValue(item, depth + 1) : 'Not provided'}`).join('; ') || 'Not provided';
  return typeof value === 'string' ? value.replaceAll('_', ' ') : String(value);
}

export function AssistantProductFacts({ facts }: { facts: { name: string; value: unknown }[] }) {
  return <dl className="assistant-product-facts">{facts.map(({ name, value }, index) => <div key={`${name}-${index}`}><dt>{attributeLabel(name)}</dt><dd>{attributeValue(value)}</dd></div>)}</dl>;
}
