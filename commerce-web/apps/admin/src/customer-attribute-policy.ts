// Match the scalar types exposed by the customer segment fields API.
export function supportsCustomerSegments(inputType: string): boolean {
  return ['text', 'textarea', 'select', 'boolean', 'number', 'date'].includes(inputType);
}

export async function createMissingStarterAttributes<T extends { attribute_code: string }>(
  starters: T[], list: () => Promise<{ attribute_code: string }[]>, save: (item: T) => Promise<unknown>,
): Promise<void> {
  const existing = new Set((await list()).map(item => item.attribute_code));
  for (const item of starters) {
    if (!existing.has(item.attribute_code)) await save(item);
  }
}
