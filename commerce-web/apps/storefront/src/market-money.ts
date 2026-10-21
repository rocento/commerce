// Decimal strings stay exact even above JavaScript's safe integer range.
export function minorUnits(value: string): bigint | null {
  if (value.length > 40 || !/^-?\d+(\.\d{1,2})?$/.test(value)) return null;
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const units = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -units : units;
}
export function decimalAmount(units: bigint): string {
  const magnitude = units < 0n ? -units : units;
  return `${units < 0n ? '-' : ''}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, '0')}`;
}
export function subtractMoney(left: string, right: string): string {
  const a = minorUnits(left), b = minorUnits(right);
  return a === null || b === null ? '—' : decimalAmount(a - b);
}
export function displayMoney(value: string, currency: string): string {
  const units = minorUnits(value);
  if (units === null) return '—';
  const magnitude = units < 0n ? -units : units;
  return `${units < 0n ? '-' : ''}${currency === 'USD' ? '$' : `${currency} `}${(magnitude / 100n).toLocaleString('en')}.${(magnitude % 100n).toString().padStart(2, '0')}`;
}
