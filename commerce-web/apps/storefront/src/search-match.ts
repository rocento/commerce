// Keep highlighting aligned with the Arabic aliases used by the search adapter.
function fold(text: string) {
  return text.replace(/[\u0640\u064b-\u065f\u0670]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[٠-٩۰-۹]/g, digit => String(digit.charCodeAt(0) - (digit <= '٩' ? 0x0660 : 0x06f0)))
    .toLocaleLowerCase();
}

export function findSearchMatch(text: string, query: string): { start: number; end: number } | null {
  const needle = fold(query);
  if (!needle) return null;
  let normalized = '', offset = 0;
  const starts: number[] = [], ends: number[] = [];
  for (const character of text) {
    const value = fold(character);
    const end = offset + character.length;
    if (!value && ends.length) ends[ends.length - 1] = end;
    for (let i = 0; i < value.length; i++) { starts.push(offset); ends.push(end); }
    normalized += value;
    offset = end;
  }
  const start = normalized.indexOf(needle);
  return start < 0 ? null : { start: starts[start], end: ends[start + needle.length - 1] };
}
