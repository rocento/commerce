import type { components } from './schema';
type Consent = components['schemas']['MetaConsent'];
const empty: Consent = {};
const partial: Consent = { whatsapp: false };
const full: Consent = { whatsapp: true, conversions: true, phone: '+20123456789' };
// @ts-expect-error Unknown consent fields are rejected.
const unknown: Consent = { unknown: false };
// @ts-expect-error Consent flags are booleans.
const wrong: Consent = { whatsapp: 'false' };
// @ts-expect-error Null is not an omitted phone.
const nullable: Consent = { phone: null };
void [empty, partial, full, unknown, wrong, nullable];
