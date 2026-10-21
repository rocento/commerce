import { CommerceError } from './commerceError';
import { validAttempt, validCommerceResponse, validQuote } from './commerceValidation';
import { filterParameters, type CatalogFilters } from './catalogFilters';
import type { ReorderContext, ReorderProposal, ReorderSelection, ReorderTask } from './reorder';
import { validReview, type Review, type ReviewInput } from './reviews';
import { parseHistory, type MemoryView, type MemoryAction, type SavedGoal } from './assistantLibrary';
import { validSupport, supportTextValid, type SupportInput, type SupportTicket, type SupportDetail } from './support';
import { AssistantDecoder, isID, type AssistantInput, type AssistantEvent, type Json } from './assistant';
// Identity is compiled into this app, never supplied by downloaded presentation data.
export const merchant = Object.freeze({ id: '312f9ac8-4888-4d35-92a0-e5fdb3bf59b8', origin: 'https://grocery.rocento.com/api', name: 'Rocento Grocery' });
export type Locale = 'en' | 'ar';
export interface StorefrontConfiguration {
  readonly identity: typeof merchant;
  readonly commerce: CommerceClient;
  readonly design?: import("./design").StorefrontDesign;
}
export interface LiveProduct {
  id: string; name: string; description: string; price: string; currency: string;
  in_stock: boolean; active?: boolean; product_type?: string; media_ids?: string[];
  attributes?: Record<string, unknown>;
  unit?: string | null;
  catalog_offer?: { product_id: string; currency: string; original_price: string; discounted_price: string };
}
export interface Category { id: string; name: string; slug: string; thumbnail?: string | null; parent_id?: string | null }
export interface Customer { id: string; primary_identifier?: string; email?: string | null; mobile_number?: string | null; verified: boolean }
interface Auth { customer: Customer; access_token: string }
export interface Cart { id: string; items: { product_id: string; name: string; quantity: number; reserved_quantity: number; price: string; line_total: string }[]; subtotal: string; currency: string; fully_reserved: boolean; discount_amount?: string; coupon_code?: string | null; coupon_error?: string | null }
export interface Pin { latitude: number; longitude: number }
export interface Location extends Pin { id: string; label: string; formatted_address: string; building: string; floor: string; apartment: string; delivery_instructions: string; is_default: boolean; updated_at?: string; location_method?: string; geography?: Record<string, unknown> | null }
export interface Fulfillment { methods: { type: string; scheduling: boolean; asap?: boolean; locations?: { id: string; name: string }[] }[] }
export interface Slot { schedule_id: string; source_id: string; starts_at: string; ends_at: string; availability: string }
export interface DeliveryRequest { method: string; location_id: string | null; source_id: string | null; date: string; asap: boolean }
export interface Options { groups: { source_id: string; source_name: string; slots: Slot[] }[] }
export interface Quote { id: string; expires_at: string; snapshot: { subtotal: string; discount_amount: string; delivery_fee: string; tax_amount: string; total: string; currency: string; payment_method: string; gift_message?: string | null } }
export interface Order { id: string; number: number; status: string; total: string; currency: string; created_at: string; gift_message?:string|null;subtotal?:string;discount_amount?:string;delivery_fee?:string;tax_amount?:string }
export interface OrderItem { product_id:string;name:string;quantity:number;price:string;line_total:string;unit?:string;discount_amount?:string }
export interface OrderDetail { order: Order; history: { id: string; status: string; created_at: string }[];items?:OrderItem[] }
export interface Attempt { customerID: string; quote: Quote; key: string }
export interface Storage { get(key: string): Promise<string | null>; set(key: string, value: string | null): Promise<void> }
export type Transport = (url: string, init: RequestInit) => Promise<Response>;
export { CommerceError } from './commerceError';
const uuid = (value: string) => {
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value)) throw new CommerceError(422, 'Invalid resource');
  return value;
};
export function validPin(pin: Pin) {
  return Number.isFinite(pin.latitude) && Number.isFinite(pin.longitude) && Math.abs(pin.latitude) <= 90 && Math.abs(pin.longitude) <= 180;
}
export function imageURL(product: LiveProduct) {
  const id = typeof product.attributes?.['demo-thumbnail'] === 'string' ? product.attributes['demo-thumbnail'] : product.media_ids?.[0];
  if (!id) return undefined;
  try { return `${merchant.origin}/v1/catalog/media/${uuid(id)}/content?width=480`; } catch { return undefined; }
}

export function categoryImageURL(category: Category) {
  if (!category.thumbnail) return undefined;
  // Category media may not have a resized derivative; use the original asset.
  try { return `${merchant.origin}/v1/catalog/media/${uuid(category.thumbnail)}/content`; } catch { return undefined; }
}

// Offers must refer to this exact product, currency and current base price.
export function displayPrice(product: LiveProduct) {
  const o = product.catalog_offer;
  const decimal = (v: string) => /^\d+(?:\.\d+)?$/.test(v) && Number.isFinite(Number(v));
  return o && o.product_id === product.id && o.currency === product.currency && [product.price, o.original_price, o.discounted_price].every(decimal) && Number(o.original_price) === Number(product.price) && Number(o.discounted_price) < Number(product.price) ? o.discounted_price : product.price;
}

export class CommerceClient {
  private token: string | null = null;
  customer: Customer | null = null;
  locale: Locale = 'en';
  pin: Pin | null = null;
  private epoch = 0;
  private supportGuest: string | null = null;
  private memoryGuest: string | null = null;
  private refreshing: Promise<Customer | null> | null = null;
  private placing: Promise<OrderDetail> | null = null;
  private placingEpoch = 0;
  private writes: Promise<void> = Promise.resolve();
  private key = `rocento.rn.v1.production.${merchant.id}`;
  constructor(private transport: Transport, private storage: Storage, private randomID: () => string) {}
  newRequestID() { return this.randomID(); }
  private persist(key: string, value: string | null, epoch: number) {
    const task = this.writes.catch(() => {}).then(async () => {
      if (epoch !== this.epoch) throw new CommerceError(401, 'Session changed');
      await this.storage.set(key, value);
    });
    this.writes = task;
    return task;
  }
  private async responseText(response: Response, maxBytes: number) {
    // Expo's production transport streams. React Native's synthetic Response
    // (used by injected transports) can expose only the already-buffered text.
    if (!response.body) {
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > maxBytes) throw new CommerceError(502, 'Response exceeds supported size');
      return text;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parts: string[] = [];
    let bytes = 0;
    let complete = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { complete = true; break; }
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new CommerceError(502, 'Response exceeds supported size');
        parts.push(decoder.decode(value, { stream: true }));
      }
      parts.push(decoder.decode());
      return parts.join('');
    } finally {
      // Cleanup must not replace the size/transport error with a cancellation failure.
      try { if (!complete) await reader.cancel().catch(() => {}); }
      finally { reader.releaseLock(); }
    }
  }
  private async raw(path: string, method = 'GET', body?: unknown, bearer?: string | null, refresh?: string | null, signal?: AbortSignal, supportGuest?: string, memoryGuest?:string) {
    if (!path.startsWith('v1/') || path.includes('://') || path.includes('..') || path.includes('#')) throw new CommerceError(422, 'Invalid request');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort);
    if (signal?.aborted) abort();
    const timeout = setTimeout(abort, 20000);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Commerce-Request': '1', 'X-Storefront-Locale': this.locale };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (refresh) headers.Cookie = `customer_refresh=${refresh}`;
    if (supportGuest) headers.Cookie = `support_guest=${supportGuest}`;
    if (memoryGuest) headers.Cookie = `assistant_guest=${memoryGuest}`;
    if (this.pin) {
      headers['X-Delivery-Context'] = '1';
      headers['X-Delivery-Latitude'] = String(this.pin.latitude);
      headers['X-Delivery-Longitude'] = String(this.pin.longitude);
    }
    try {
      const response = await this.transport(`${merchant.origin}/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit', redirect: 'error', signal: controller.signal });
      const text = await this.responseText(response, 2_000_000);
      let data: unknown = null;
      if (text) { try { data = JSON.parse(text); } catch { throw new CommerceError(502, 'Invalid server response'); } }
      if (response.ok && !validCommerceResponse(path, method, data)) throw new CommerceError(502, 'Invalid server response');
      return { response, data };
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
  }
  private checked<T>({ response, data }: Awaited<ReturnType<CommerceClient['raw']>>): T {
    if (!response.ok) {
      const error = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : 'Request failed. Please retry.';
      throw new CommerceError(response.status, error.slice(0, 400));
    }
    return data as T;
  }
  private refreshCookie(response: Response) {
    const match = /(?:^|,\s*)customer_refresh=([A-Za-z0-9_-]{32,512})(?:;|$)/.exec(response.headers.get('set-cookie') ?? '');
    if (!match?.[1]) throw new CommerceError(502, 'Unable to establish a secure session');
    return match[1];
  }
  private async accept(result: Awaited<ReturnType<CommerceClient['raw']>>, epoch: number) {
    const auth = this.checked<Auth>(result);
    if (!auth?.customer?.id || !auth.access_token) throw new CommerceError(502, 'Invalid session response');
    await this.persist(`${this.key}.refresh`, this.refreshCookie(result.response), epoch);
    if (epoch !== this.epoch) throw new CommerceError(401, 'Session changed');
    this.token = auth.access_token; this.customer = auth.customer;
    return auth.customer;
  }
  async login(identifier: string, password: string) {
    this.memoryGuest=null;
    const epoch = ++this.epoch;
    this.token = null; this.customer = null; this.pin = null; this.refreshing = null;
    await this.persist(`${this.key}.refresh`, null, epoch);
    return this.accept(await this.raw('v1/customer/auth/login', 'POST', { identifier: identifier.trim(), password }), epoch);
  }
  restore(): Promise<Customer | null> {
    if (this.refreshing) return this.refreshing;
    const epoch = this.epoch;
    const task = (async () => {
      await this.writes;
      const saved = await this.storage.get(`${this.key}.refresh`);
      if (!saved) return null;
      try {
        const result = await this.raw('v1/customer/auth/refresh', 'POST', undefined, null, saved);
        if (result.response.status === 204) throw new CommerceError(401, 'Please sign in');
        return await this.accept(result, epoch);
      } catch (error) {
        if (epoch === this.epoch && error instanceof CommerceError && [401, 403].includes(error.status)) {
          this.token = null; this.customer = null; this.pin = null;
          await this.persist(`${this.key}.refresh`, null, epoch);
        }
        throw error;
      }
    })();
    this.refreshing = task;
    void task.finally(() => { if (this.refreshing === task) this.refreshing = null; }).catch(() => {});
    return task;
  }
  async logout() {
    this.memoryGuest=null;
    const token = this.token;
    const epoch = ++this.epoch;
    this.customer = null; this.token = null; this.pin = null; this.refreshing = null;
    await this.writes.catch(() => {});
    const refresh = await this.storage.get(`${this.key}.refresh`);
    await this.persist(`${this.key}.refresh`, null, epoch);
    // Local logout succeeds even offline; never restore this credential implicitly.
    try { await this.raw('v1/customer/auth/logout', 'POST', undefined, token, refresh); } catch { /* local credential removed */ }
  }
  async request<T>(path: string, method = 'GET', body?: unknown, authenticated = true, signal?: AbortSignal): Promise<T> {
    if (!path.startsWith('v1/') || path.includes('://') || path.includes('..') || path.includes('#')) throw new CommerceError(422, 'Invalid request');
    const epoch = this.epoch;
    if (authenticated && !this.token && !await this.restore()) throw new CommerceError(401, 'Please sign in');
    const sent = authenticated ? this.token : null;
    let result = await this.raw(path, method, body, sent, null, signal);
    if (epoch !== this.epoch) throw new CommerceError(401, 'Session changed');
    if (authenticated && result.response.status === 401) {
      if (this.token === sent && !await this.restore()) throw new CommerceError(401, 'Please sign in');
      result = await this.raw(path, method, body, this.token, null, signal);
      if (epoch !== this.epoch) throw new CommerceError(401, 'Session changed');
    }
    return this.checked<T>(result);
  }
  authAction(action: 'register' | 'request-verification' | 'verify' | 'forgot-password' | 'reset-password', identifier: string, password?: string, token?: string) {
    return this.request(`v1/customer/auth/${action}`, 'POST', { identifier: identifier.trim(), password, token }, false);
  }
  categories(signal?: AbortSignal) { return this.request<Category[]>('v1/catalog/categories', 'GET', undefined, false, signal); }
  async designCollection(id: string, signal?: AbortSignal): Promise<LiveProduct[]> {
    if (id.startsWith('demo-feed-')) {
      const theme = await this.request<{ configuration: { pages: { home: { id: string; enabled: boolean; component: string; settings: { query?: string; category?: string; limit?: number; period?: string } }[] } } }>('v1/theme/storefront', 'GET', undefined, false, signal);
      const section = theme.configuration.pages.home.find(s => s.id === id.slice(10) && s.enabled);
      if (!section || !['featured_products','product_collection','recommendations','best_sellers'].includes(section.component)) throw new Error('Collection unavailable');
      const limit = Math.min(24, Math.max(1, section.settings.limit ?? 8));
      if (section.component === 'best_sellers') {
        const period = section.settings.period ?? 'last_month';
        if (!['today','last_week','last_month','last_year'].includes(period)) throw new Error('Invalid collection period');
        const result = await this.request<{ products: LiveProduct[] }>(`v1/catalog/bestsellers?period=${period}&limit=${limit}`, 'GET', undefined, false, signal);
        return result.products.slice(0, limit);
      }
      return (await this.search(section.settings.query ?? '', section.settings.category ?? '', 0, signal)).hits.slice(0, limit);
    }
    const category = (await this.categories(signal)).find(c => c.id === id || c.slug === id);
    if (!category) throw new Error('Collection unavailable');
    return (await this.search('', category.id, 0, signal)).hits;
  }
  search(query = '', category = '', offset = 0, signal?: AbortSignal, filters?: CatalogFilters) {
    const params = new URLSearchParams({ q: query, limit: '24', offset: String(offset) });
    if (category) params.set('category_id', uuid(category));
    if (filters) filterParameters(filters).forEach((value, key) => params.set(key, value));
    return this.request<{ hits: LiveProduct[]; total: number }>(`v1/search?${params}`, 'GET', undefined, false, signal);
  }
  product(id: string) { return this.request<LiveProduct>(`v1/catalog/products/${uuid(id)}`, 'GET', undefined, false); }
  reviews(id: string, offset = 0) { return this.request<Review[]>(`v1/products/${uuid(id)}/reviews?offset=${Math.max(0, Math.floor(offset))}`, 'GET', undefined, false); }
  supportTickets() { return this.request<SupportTicket[]>('v1/customer/support/tickets'); }
  supportDetail(id:string) { return this.request<SupportDetail>(`v1/customer/support/tickets/${uuid(id)}`); }
  async createSupport(input:SupportInput) {
    if(!validSupport(input,!!this.customer))throw new CommerceError(422,'Complete the support form');
    const {subject,category,body,contact_name,contact}=input;
    const payload={request_id:uuid(input.request_id),subject,category,body,order_id:input.order_id?uuid(input.order_id):undefined,contact_name,contact};
    if(this.customer)return this.request<SupportDetail>('v1/support/tickets','POST',payload);
    const revision=this.epoch;
    if(!this.supportGuest){const result=await this.raw('v1/support/session','POST');this.checked(result);const cookie=/(?:^|,\s*)support_guest=([A-Za-z0-9]{48})(?:;|$)/.exec(result.response.headers.get('set-cookie')??'')?.[1];if(!cookie)throw new CommerceError(502,'Unable to establish a support session');if(revision!==this.epoch)throw new CommerceError(401,'Session changed');this.supportGuest=cookie;}
    const result=await this.raw('v1/support/tickets','POST',payload,undefined,undefined,undefined,this.supportGuest);
    if(revision!==this.epoch)throw new CommerceError(401,'Session changed');return this.checked<SupportDetail>(result);
  }
  replySupport(id:string,requestID:string,body:string) { if(!supportTextValid(body,2000))throw new CommerceError(422,'Enter a message within 2000 bytes');return this.request<SupportDetail>(`v1/customer/support/tickets/${uuid(id)}/messages`,'POST',{request_id:uuid(requestID),body}); }
  ownReview(id: string) { return this.request<Review | null>(`v1/customer/products/${uuid(id)}/review`); }
  submitReview(id: string, input: ReviewInput) {
    if (!this.customer?.verified || !validReview(input)) throw new CommerceError(422, 'Verify your account and complete a valid review');
    const { display_name, rating, title, body } = input;
    return this.request<Review>(`v1/customer/products/${uuid(id)}/review`, 'PUT', { display_name, rating, title, body });
  }
  relationships(sources: string[], kind: 'related' | 'upsell' | 'cross_sell') {
    if (!sources.length || sources.length > 50) throw new CommerceError(422, 'Choose between 1 and 50 source products');
    const query = new URLSearchParams({ sources: [...new Set(sources.map(uuid))].sort().join(','), kind });
    return this.request<LiveProduct[]>(`v1/catalog/relationships?${query}`, 'GET', undefined, !!this.customer);
  }
  family(id: string) { return this.request<{ children: LiveProduct[] }>(`v1/catalog/products/${uuid(id)}/family`, 'GET', undefined, false); }
  cart() { return this.request<Cart>('v1/cart', 'POST'); }
  coupon(code: string) { return this.request<Cart>('v1/cart/coupon', 'PUT', { code: code.trim() }); }
  async add(product: LiveProduct, quantity = 1) {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new CommerceError(422, 'Invalid quantity');
    const epoch = this.epoch;
    if (!this.pin) throw new CommerceError(422, 'Choose a delivery address before adding products');
    const current = await this.product(product.id);
    if (!current.in_stock || current.active === false || current.product_type === 'configurable') throw new CommerceError(422, 'Choose an available product option');
    await this.cart();
    if (epoch !== this.epoch) throw new CommerceError(401, 'Session changed');
    return this.request<Cart>('v1/cart/items', 'POST', { product_id: uuid(current.id), quantity });
  }
  quantity(id: string, quantity: number) {
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 99) throw new CommerceError(422, 'Invalid quantity');
    return this.request<Cart>(`v1/cart/items/${uuid(id)}`, quantity ? 'PUT' : 'DELETE', quantity ? { quantity } : undefined);
  }
  locations() { return this.request<Location[]>('v1/customer/locations'); }
  async saveLocation(input: Omit<Location, 'id' | 'is_default' | 'label'>) {
    if (!validPin(input) || !input.formatted_address.trim()) throw new CommerceError(422, 'Choose a valid delivery pin and address');
    return this.request<Location>('v1/customer/locations', 'POST', { ...input, label: 'home', is_default: true });
  }
  coverage() { return this.request<{ configured: boolean; deliverable: boolean }>('v1/delivery-area', 'GET', undefined, false); }
  fulfillment() { return this.request<Fulfillment>('v1/fulfillment/availability'); }
  options(request: DeliveryRequest) { return this.request<Options>('v1/fulfillment/plan-options', 'POST', request); }
  async quote(request: DeliveryRequest, windows: Slot[], giftMessage = '') {
    if (new TextEncoder().encode(giftMessage).length > 500) throw new CommerceError(422, 'Please shorten your gift message');
    await this.request('v1/fulfillment/plans', 'POST', { request, windows: windows.map(({ schedule_id, source_id, starts_at, ends_at }) => ({ schedule_id, source_id, starts_at, ends_at })), idempotency_key: this.randomID() });
    return this.request<Quote>('v1/customer/checkout/quote', 'POST', { location_id: request.location_id, gift_message: giftMessage });
  }
  async pending(): Promise<Attempt | null> {
    const epoch = this.epoch;
    const customer = this.customer;
    if (!customer) return null;
    const saved = await this.storage.get(`${this.key}.checkout.${uuid(customer.id)}`);
    if (epoch !== this.epoch) throw new CommerceError(401, 'Session changed');
    if (!saved) return null;
    let attempt: unknown;
    try { attempt = JSON.parse(saved); } catch { throw new CommerceError(502, 'Saved checkout is unreadable'); }
    if (!validAttempt(attempt, customer.id)) throw new CommerceError(502, 'Saved checkout is invalid');
    return attempt as Attempt;
  }
  place(quote: Quote): Promise<OrderDetail> {
    if (this.placing) return this.placingEpoch === this.epoch ? this.placing : Promise.reject(new CommerceError(409, 'Previous checkout is still finishing'));
    this.placingEpoch = this.epoch;
    const task = this.placeOnce(quote);
    this.placing = task;
    void task.finally(() => { if (this.placing === task) this.placing = null; }).catch(() => {});
    return task;
  }
  private async placeOnce(quote: Quote) {
    if (!validQuote(quote)) throw new CommerceError(422, 'Invalid checkout quote');
    const customer = this.customer;
    const epoch = this.epoch;
    if (!customer) throw new CommerceError(401, 'Please sign in');
    const key = `${this.key}.checkout.${uuid(customer.id)}`;
    const pending = await this.pending();
    if (pending && pending.quote.id !== quote.id) throw new CommerceError(409, 'Resolve the previous checkout attempt first');
    if (!pending && Date.parse(quote.expires_at) <= Date.now()) throw new CommerceError(400, 'Quote expired. Review again.');
    const attempt = pending ?? { customerID: customer.id, quote, key: this.randomID() };
    await this.persist(key, JSON.stringify(attempt), epoch);
    try {
      const result = await this.request<OrderDetail>('v1/customer/checkout/place', 'POST', { quote_id: uuid(quote.id), idempotency_key: attempt.key });
      await this.persist(key, null, epoch);
      return result;
    } catch (error) {
      if (error instanceof CommerceError && error.status === 400) await this.persist(key, null, epoch);
      throw error; // Network/5xx uncertainty retains the same key across restarts.
    }
  }
  wishlist() { return this.request<string[]>('v1/customer/wishlist').then(ids => { if (!Array.isArray(ids) || ids.some(id => !isID(id))) throw new CommerceError(502, 'Invalid saved products'); return [...new Set(ids)]; }); }
  saveProduct(id: string, saved: boolean) { return this.request(`v1/customer/wishlist/${uuid(id)}`, saved ? 'PUT' : 'DELETE'); }
  async saveForLater(id: string) {
    const epoch = this.epoch;
    await this.saveProduct(id, true);
    if (epoch !== this.epoch) throw new CommerceError(401, 'Session changed');
    return this.quantity(id, 0); // Never remove a cart line unless saving succeeded.
  }
  assistantID() { return this.randomID(); }
  async assistantHistory(id?:string){return parseHistory(await this.request<unknown>(`v1/assistant/history${id?`?conversation_id=${uuid(id)}`:''}`));}
  private async memoryRequest<T>(path:string,method='GET',body?:unknown):Promise<T>{
    if(!this.customer&&await this.storage.get(`${this.key}.refresh`))await this.restore();
    if(this.customer)return this.request<T>(path,method,body);
    const revision=this.epoch,result=await this.raw(path,method,body,undefined,undefined,undefined,undefined,this.memoryGuest??undefined);
    const value=this.checked<T>(result);if(revision!==this.epoch)throw new CommerceError(401,'Session changed');
    const header=result.response.headers.get('set-cookie')??'',cookie=/(?:^|,\s*)assistant_guest=([A-Za-z0-9]{48})(?:;|$)/.exec(header)?.[1];
    if(cookie)this.memoryGuest=cookie;else if(header.includes('assistant_guest=;'))this.memoryGuest=null;
    return value;
  }
  async memoryView(id:string){const value=await this.memoryRequest<MemoryView>(`v1/assistant/memory?conversation_id=${uuid(id)}`);if(value.enabled&&value.guest&&!this.memoryGuest)throw new CommerceError(503,'Guest memory session unavailable');return value;}
  async savedGoals(){return (await this.request<{goals:SavedGoal[]}>('v1/cart/saved-goals')).goals;}
  exportMemory(){return this.memoryRequest<unknown>('v1/assistant/memory/export');}
  async changeMemory(action:MemoryAction){
    switch(action.kind){
      case 'consent':return this.memoryRequest('v1/assistant/memory','PUT',{personalized:action.personalized,journey:action.personalized&&action.journey,expected_version:action.version});
      case 'preference':{const p=action.input;return this.memoryRequest('v1/assistant/memory/preferences','POST',{attribute:p.attribute,value:p.value,category_id:uuid(p.category_id),occasion:p.occasion,recipient:p.recipient,goal_id:p.goal_id?uuid(p.goal_id):null,dislike:p.dislike,replaces:p.replaces?uuid(p.replaces):null});}
      case 'removePreference':return this.memoryRequest(`v1/assistant/memory/preferences/${uuid(action.id)}`,'DELETE');
      case 'clearContext':return this.memoryRequest(`v1/assistant/memory/context/${uuid(action.id)}`,'DELETE');
      case 'delete':return this.memoryRequest('v1/assistant/memory','DELETE');
      case 'goal':if(!action.name.trim()||[...action.name].length>100||/[\u0000-\u001f\u007f]/.test(action.name))throw new CommerceError(422,'Choose a goal name of 1–100 characters');return this.request(`v1/cart/saved-goals/${uuid(action.goal.task_id)}`,'PUT',{name:action.name,archived:action.archived,expected_version:action.goal.version});
      case 'deleteGoal':return this.request(`v1/cart/saved-goals/${uuid(action.goal.task_id)}?version=${action.goal.version}`,'DELETE');
    }
  }
  async reorderTask(order: string, again = false): Promise<ReorderTask> {
    const epoch = this.epoch, owner = this.customer?.id;
    if (!owner) throw new CommerceError(401, 'Please sign in');
    const saved = await this.storage.get(`${this.key}.reorder.${uuid(owner)}.${uuid(order)}`);
    if (epoch !== this.epoch) throw new CommerceError(401, 'Session changed');
    if (saved && !again) {
      const task = JSON.parse(saved) as ReorderTask;
      uuid(task.task); if (typeof task.pending !== 'boolean') throw new CommerceError(502, 'Invalid saved reorder');
      return task;
    }
    const task = { task: this.randomID(), pending: false }; await this.saveReorderTask(order, task); return task;
  }
  async saveReorderTask(order: string, task: ReorderTask) {
    const owner = this.customer?.id; if (!owner) throw new CommerceError(401, 'Please sign in');
    uuid(task.task);
    await this.persist(`${this.key}.reorder.${uuid(owner)}.${uuid(order)}`, JSON.stringify(task), this.epoch);
  }
  reorderContext(task: string) { return this.request<ReorderContext>(`v1/cart/shopping/${uuid(task)}`); }
  reorderProposal(id: string) { return this.request<ReorderProposal>(`v1/cart/proposals/${uuid(id)}`); }
  async proposeReorder(task: string, order: string, location: string, selections?: ReorderSelection[]) {
    const epoch = this.epoch;
    const context = await this.reorderContext(task);
    if (epoch !== this.epoch) throw new CommerceError(401, 'Session changed');
    return this.request<ReorderProposal>('v1/cart/proposals', 'POST', {
      task_id: uuid(task), task_revision: context.task_revision, source_revision: context.source_revision,
      mode: 'buy_again', auto_select: selections === undefined, order_id: uuid(order), location_id: uuid(location), selections: selections ?? [],
      goal: { purpose: 'Reorder', budget: null, currency: null, all_inclusive: false, budget_exclusive: false, people: null, locked_products: [], excluded_products: [], locked_brands: [], allow_substitutions: false, delivery_date: null, assumptions: [], unresolved: [], saving_target: null },
    });
  }
  assistantProposal(id: string) { return this.request<Json>(`v1/cart/proposals/${uuid(id)}`); }
  async applyAssistantProposal(id: string) {
    uuid(id); const epoch = this.epoch;
    await this.request('v1/cart/trust/confirm', 'POST', { proposal_id: id, idempotency_key: id, grant_id: null });
    if (epoch !== this.epoch) throw new CommerceError(401, 'Session changed');
    return this.request<Cart>(`v1/cart/proposals/${id}/apply`, 'POST', { idempotency_key: id });
  }
  async streamAssistant(input: AssistantInput, onEvent: (event: AssistantEvent) => void, signal: AbortSignal) {
    if (!input.message.trim() || [...input.message].length > 4000 || !isID(input.request_id) || !isID(input.conversation_id) || (input.product_id != null && !isID(input.product_id)) || (input.product_id && input.cart_context)) throw new CommerceError(422, 'Invalid assistant request');
    const epoch = this.epoch;
    const check = () => { if (signal.aborted) throw new Error('Assistant stopped'); if (epoch !== this.epoch) throw new CommerceError(401, 'Session changed'); };
    if (!this.token) await this.restore(); // A saved session failure must not become a guest request.
    check();
    for (let attempt = 0; attempt < 2; attempt++) {
      const sent = this.token;
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'X-Commerce-Request': '1', 'X-Commerce-Assistant-Errors': '1', 'X-Commerce-Request-Reference': input.request_id, 'X-Storefront-Locale': this.locale, 'X-Delivery-Context': '1' };
      if (sent) headers.Authorization = `Bearer ${sent}`;
      if (!sent&&this.memoryGuest) headers.Cookie=`assistant_guest=${this.memoryGuest}`;
      if (input.personalize===false) headers['X-Commerce-Personalize']='0';
      if (this.pin) { headers['X-Delivery-Latitude'] = String(this.pin.latitude); headers['X-Delivery-Longitude'] = String(this.pin.longitude); }
      const controller = new AbortController(); const abort = () => controller.abort(); signal.addEventListener('abort', abort);
      const timeout = setTimeout(abort, 35000);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        check();
        const {personalize:_,...payload}=input;
        const response = await this.transport(`${merchant.origin}/v1/assistant/chat`, { method: 'POST', headers, body: JSON.stringify(payload), credentials: 'omit', redirect: 'error', signal: controller.signal });
        check();
        if (response.status === 401 && attempt === 0 && sent) { await response.body?.cancel(); if (this.token === sent) await this.restore(); check(); continue; }
        if (response.status !== 200) throw new CommerceError(response.status, 'Assistant request failed');
        if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') || !response.body) throw new CommerceError(502, 'Invalid assistant response');
        const parser = new AssistantDecoder(input.request_id); reader = response.body.getReader();
        while (!parser.done) {
          const chunk = await reader.read(); check(); if (controller.signal.aborted) throw new Error('Assistant timed out');
          if (chunk.done) break;
          for (const event of parser.feed(chunk.value)) { check(); onEvent(event); }
        }
        parser.finish(); check(); return;
      } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); await reader?.cancel().catch(() => {}); }
    }
  }
  orders(offset = 0) { return this.request<Order[]>(`v1/customer/orders?offset=${Math.max(0, offset)}`); }
  order(id: string) { return this.request<OrderDetail>(`v1/customer/orders/${uuid(id)}`); }
}
