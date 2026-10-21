/** Preview controls must not reset shopping forms, suggestions or open drawers. */
export function shoppingLocationKey(pathname: string, search: string): string {
  const parameters = new URLSearchParams(search);
  for (const key of ['interface_preview', 'interface_parent', 'interface_channel']) parameters.delete(key);
  return pathname + '?' + parameters.toString();
}
