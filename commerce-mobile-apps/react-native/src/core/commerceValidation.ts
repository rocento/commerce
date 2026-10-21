// HTTP payloads and persisted attempts are untrusted. Validate before publishing
// feature state or persisting a session; ignore unknown fields for API evolution.
type RecordValue = Record<string, unknown>;
type Check = (value: unknown) => boolean;
const object = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);
const string: Check = value => typeof value === 'string';
const nonempty: Check = value => typeof value === 'string' && value.length > 0;
const boolean: Check = value => typeof value === 'boolean';
const number: Check = value => typeof value === 'number' && Number.isFinite(value);
const integer: Check = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const money: Check = value => typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value));
const date: Check = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const array = (check: Check): Check => value => Array.isArray(value) && value.every(check);
const optional = (check: Check): Check => value => value === undefined || value === null || check(value);
const shape = (fields: Record<string, Check>): Check => value => object(value) && Object.entries(fields).every(([key, check]) => check(value[key]));
const customer = shape({ id: nonempty, verified: boolean, email: optional(string), mobile_number: optional(string), primary_identifier: optional(string) });
const cart = shape({ id: nonempty, items: array(shape({ product_id: nonempty, name: string, quantity: integer, reserved_quantity: integer, price: money, line_total: money })), subtotal: money, currency: nonempty, fully_reserved: boolean });
const location = shape({ id: nonempty, label: string, formatted_address: string, latitude: v => number(v) && Math.abs(v as number) <= 90, longitude: v => number(v) && Math.abs(v as number) <= 180, building: string, floor: string, apartment: string, delivery_instructions: string, is_default: boolean });
const slot = shape({ schedule_id: nonempty, source_id: nonempty, starts_at: date, ends_at: date, availability: nonempty });
export const validQuote = shape({ id: nonempty, expires_at: date, snapshot: shape({ subtotal: money, discount_amount: money, delivery_fee: money, tax_amount: money, total: money, currency: nonempty, payment_method: nonempty, gift_message: optional(string) }) });
const order = shape({ id: nonempty, number: integer, status: nonempty, total: money, currency: nonempty, created_at: date });
const detail = shape({ order, history: array(shape({ id: nonempty, status: nonempty, created_at: date })), items: optional(array(shape({ product_id: nonempty, name: string, quantity: integer, price: money, line_total: money }))) });
export const validAttempt = (value: unknown, customerID: string): boolean => shape({ customerID: v => v === customerID, quote: validQuote, key: nonempty })(value);

export function validCommerceResponse(path: string, method: string, value: unknown): boolean {
  const route = path.split('?')[0] ?? path;
  if (route === 'v1/customer/auth/login' || route === 'v1/customer/auth/refresh') return shape({ customer, access_token: nonempty })(value);
  if (route === 'v1/customer/me') return customer(value);
  if (/^v1\/cart(?:\/items(?:\/[^/]+)?|\/coupon)?$/.test(route)) return cart(value);
  if (route === 'v1/customer/locations') return (method === 'GET' ? array(location) : location)(value);
  if (route === 'v1/fulfillment/availability') return shape({ methods: array(shape({ type: nonempty, scheduling: boolean, asap: optional(boolean), locations: optional(array(shape({ id: nonempty, name: string }))) })) })(value);
  if (route === 'v1/fulfillment/plan-options') return shape({ groups: array(shape({ source_id: nonempty, source_name: string, slots: array(slot) })) })(value);
  if (route === 'v1/customer/checkout/quote') return validQuote(value);
  if (route === 'v1/customer/checkout/place' || /^v1\/customer\/orders\/[^/]+$/.test(route)) return detail(value);
  if (route === 'v1/customer/orders') return array(order)(value);
  if (route === 'v1/delivery-area') return shape({ configured: boolean, deliverable: boolean })(value);
  return true;
}
