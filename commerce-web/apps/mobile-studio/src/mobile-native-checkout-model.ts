import { previewTotals, type PromoError } from './mobile-preview-promos';
import { useEffect, useRef, useState } from 'react';
import type { PreviewProfile } from './mobile-preview-profile';
import { type CartLine, type usePreviewCart } from './mobile-preview-cart';

export type NativeAddress = { id: string; latitude: string; longitude: string; street: string; building: string; floor: string; apartment: string; instructions: string };
export type CheckoutScenario = 'none' | 'delivery' | 'stock' | 'expired' | 'pending' | 'rejected' | 'verification' | 'location';
export type CheckoutError = 'address' | 'branch' | 'date' | 'slots' | 'delivery' | 'stock' | 'expired' | 'pending' | 'rejected' | 'verification' | 'promo' | null;
export type CancellationReason = 'changed_mind' | 'wrong_items' | 'wrong_address' | 'other';
export type Cancellation = { reason: CancellationReason; date: number; prepaid: boolean; refund: 'not_required' | 'pending' | 'failed' | 'refunded'; updated: number };
export const canCancelOrder = (order: NativeOrder) => !order.cancellation && ['placed','confirmed','fulfilling'].includes(order.history.at(-1)?.status || '');
export type NativeOrder = { id: string; total: number; currency: string; method: 'delivery' | 'pickup'; created: number; history: { status: string; date: number }[]; lines: CartLine[]; address?: NativeAddress; branch: string; day: string; windows: Record<string,string>; subtotal: number; delivery: number; tax: number; discount: number; promoCode?: string; deliveryDiscount?: number; cancellation?: Cancellation };

export const orderStages = (method: 'delivery' | 'pickup') => method === 'pickup'
  ? ['placed','confirmed','fulfilling','pickup_ready','picked_up']
  : ['placed','confirmed','fulfilling','shipped','out_for_delivery','delivered'];
function readPreviewOrders(key: string): NativeOrder[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) || '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((o): o is NativeOrder => o && typeof o.id === 'string' && o.id.startsWith('PREVIEW-')
      && (o.method === 'delivery' || o.method === 'pickup') && Number.isFinite(o.created)
      && ['total','subtotal','delivery','tax','discount'].every(k => Number.isFinite(o[k]))
      && (o.promoCode === undefined || typeof o.promoCode === 'string') && (o.deliveryDiscount === undefined || Number.isFinite(o.deliveryDiscount) && o.deliveryDiscount >= 0)
      && typeof o.currency === 'string' && /^[A-Z]{3}$/.test(o.currency)
      && typeof o.branch === 'string' && typeof o.day === 'string' && o.windows && typeof o.windows === 'object' && Object.values(o.windows).every(v => typeof v === 'string')
      && (!o.address || ['id','latitude','longitude','street','building','floor','apartment','instructions'].every(k => typeof o.address[k] === 'string'))
      && Array.isArray(o.lines) && o.lines.length > 0 && o.lines.every((l: CartLine) => l && Number.isInteger(l.quantity) && l.quantity > 0 && l.quantity <= 99 && l.product && typeof l.product.id === 'string' && typeof l.product.name === 'string' && typeof l.product.price === 'string' && Number.isFinite(Number(l.product.price)))
      && (!o.cancellation || (['changed_mind','wrong_items','wrong_address','other'].includes(o.cancellation.reason) && Number.isFinite(o.cancellation.date) && Number.isFinite(o.cancellation.updated) && typeof o.cancellation.prepaid === 'boolean' && (o.cancellation.prepaid ? ['pending','failed','refunded'].includes(o.cancellation.refund) : o.cancellation.refund === 'not_required')))
      && Array.isArray(o.history) && o.history.length > 0 && o.history.length <= orderStages(o.method).length
      && o.history.every((h: {status:string;date:number}, i:number) => h && h.status === orderStages(o.method)[i] && Number.isFinite(h.date)));
  } catch { return []; }
}

type Quote = { id: string; cartKey: string; subtotal: number; discount: number; delivery: number; tax: number; total: number; currency: string; expires: number; method: 'delivery' | 'pickup'; promoCode?: string; deliveryDiscount?: number };
type Options = { cartKey: string; groups: string[] };
type State = {
  merchant: string; method: 'delivery' | 'pickup'; branch: string; asap: boolean; day: string;
  addresses: NativeAddress[]; selectedAddress: string; addressOpen: boolean; addressId: string;
  options: Options | null; windows: Record<string, string>; quote: Quote | null; pending: boolean;
  orders: NativeOrder[]; detailId: string; scenario: CheckoutScenario; error: CheckoutError;
  promoCode: string; promoAttemptError: PromoError | null; stockId: string; confirmed: boolean; split: boolean; verified: boolean;
};
export function previewToday() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function validDeliveryPin(latitude: string, longitude: string) {
  return latitude.trim() !== '' && longitude.trim() !== '' && Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude)) && Math.abs(Number(latitude)) <= 90 && Math.abs(Number(longitude)) <= 180;
}
export function nativeCartKey(lines: CartLine[]) { return JSON.stringify(lines.map(l => [l.product.id, l.quantity, l.product.price, l.product.currency, l.product.inStock])); }
const fresh = (merchant: string): State => ({ merchant, method: 'delivery', branch: '', asap: true, day: previewToday(), addresses: [], selectedAddress: '', addressOpen: false, addressId: '', options: null, windows: {}, quote: null, pending: false, orders: [], detailId: '', scenario: 'none', error: null, confirmed: false, promoCode: '', promoAttemptError: null, stockId: '', split: false, verified: true });
const invalidated = { options: null, windows: {}, quote: null, error: null, confirmed: false };
export function useNativePreviewCheckout(merchant: string, cart: ReturnType<typeof usePreviewCart>, profile: PreviewProfile, platform: string) {
  const orderKey = `rocento:preview-orders:v1:${merchant}:${platform}`;
  const [orders, setOrders] = useState<NativeOrder[]>(() => readPreviewOrders(orderKey));
  useEffect(() => { try { sessionStorage.setItem(orderKey, JSON.stringify(orders)); } catch { /* Continue in memory if storage is unavailable. */ } }, [orderKey, orders]);
  const [saved, setSaved] = useState(() => fresh(merchant));
  const [clock, setClock] = useState(Date.now());
  const confirmationLock = useRef(false);
  const raw = saved.merchant === merchant ? saved : fresh(merchant);
  const addresses = profile.addresses.map(a => a.native || { id:a.id, latitude:'', longitude:'', street:a.address.street, building:'', floor:'', apartment:'', instructions:'' });
  const selectedAddress = raw.selectedAddress || profile.defaultId;
  const s = { ...raw, orders, addresses, selectedAddress };
  const cartKey = nativeCartKey(cart.lines) + JSON.stringify([s.promoCode,s.method,s.branch,s.asap,s.day,s.split,s.selectedAddress,s.addresses.find(a=>a.id===s.selectedAddress)]);
  const totals = previewTotals(cart.lines,s.method,s.promoCode);
  const quote = s.quote?.cartKey === cartKey ? s.quote : null;
  const options = s.options?.cartKey === cartKey ? s.options : null;
  const pending = s.pending && !!quote;
  useEffect(() => { setSaved(fresh(merchant)); confirmationLock.current = false; }, [merchant]);
  useEffect(() => { confirmationLock.current = false; }, [s.quote?.id, s.pending]);
  useEffect(() => {
    if (!quote || pending) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [quote?.id, pending]);
  const patch = (update: Partial<State>) => setSaved(current => ({ ...(current.merchant === merchant ? current : fresh(merchant)), ...update }));
  const expired = !!quote && !pending && Math.max(clock, Date.now()) >= quote.expires;
  const stocked = cart.lines.every(l => l.product.inStock && !(s.scenario === 'stock' && s.stockId === l.product.id));
  function fulfillmentError(): CheckoutError {
    if (s.method === 'delivery' && !s.addresses.some(a => a.id === s.selectedAddress && validDeliveryPin(a.latitude,a.longitude))) return 'address';
    if (s.method === 'pickup' && !s.branch) return 'branch';
    if (!s.asap && (!/^\d{4}-\d{2}-\d{2}$/.test(s.day) || Number.isNaN(Date.parse(s.day)) || s.day < previewToday() || new Date(`${s.day}T12:00:00Z`).toISOString().slice(0, 10) !== s.day)) return 'date';
    if (totals.error) return 'promo';
    if (!stocked) return 'stock';
    if (s.scenario === 'delivery') return 'delivery';
    return null;
  }
  function checkAvailability() {
    if (pending || !cart.lines.length) return;
    const error = fulfillmentError();
    patch({ ...invalidated, error, options: error ? null : { cartKey, groups: s.split ? ['main', 'fresh'] : ['main'] } });
  }
  function review() {
    if (pending || !cart.lines.length || !options) return;
    const error = fulfillmentError() || (!s.asap && options.groups.some(g => !s.windows[g]) ? 'slots' : null) || (!s.verified ? 'verification' : null);
    if (error) { patch({ error, quote: null }); return; }
    const {currency,subtotal,discount,delivery,deliveryDiscount,tax,total} = totals;
    confirmationLock.current = false;
    patch({ error: null, confirmed: false, quote: { id: `PREVIEW-${crypto.randomUUID().slice(0, 8).toUpperCase()}`, cartKey, subtotal, discount, tax, delivery, deliveryDiscount, promoCode:s.promoCode || undefined, total, currency, expires: Date.now() + 300000, method: s.method } });
  }
  function place() {
    if (!quote || confirmationLock.current || !cart.lines.length) return;
    confirmationLock.current = true;
    if (!pending && (s.scenario === 'expired' || Date.now() >= quote.expires)) { patch({ ...invalidated, error: 'expired' }); return; }
    if (!pending && totals.error) { patch({...invalidated,error:'promo'}); return; }
    if (!pending && (s.scenario === 'rejected' || !s.verified || !stocked || s.scenario === 'delivery')) {
      patch({ ...invalidated, error: s.scenario === 'rejected' ? 'rejected' : !s.verified ? 'verification' : !stocked ? 'stock' : 'delivery' }); return;
    }
    if (!pending && s.scenario === 'pending') { patch({ pending: true, error: 'pending' }); return; }
    const created = Date.now();
    const order: NativeOrder = { id: quote.id, total: quote.total, currency: quote.currency, method: quote.method, created, lines: structuredClone(cart.lines), address: s.method === 'delivery' ? structuredClone(s.addresses.find(a => a.id === s.selectedAddress)) : undefined, branch: s.branch, day: s.asap ? '' : s.day, windows: {...s.windows}, subtotal: quote.subtotal, delivery: quote.delivery, tax: quote.tax, discount: quote.discount, promoCode: quote.promoCode, deliveryDiscount: quote.deliveryDiscount, history: [{status:'placed',date:created}] };
    setOrders(current => current.some(o => o.id === order.id) ? current : [order, ...current]);
    patch({ ...invalidated, quote: null, pending: false, detailId: order.id, confirmed: true, promoCode:'', promoAttemptError:null });
    cart.clear();
  }
  const detail = s.orders.find(o => o.id === s.detailId);
  return {
    state: { ...s, quote, options, pending }, cart, detail, expired, stocked, totals,
    applyPromo: (input: string) => {
      if (pending) return;
      const code=input.trim().toUpperCase();
      const error=code ? previewTotals(cart.lines,s.method,code).error : 'invalid';
      if(error) {patch({promoAttemptError:error});return;}
      patch({...invalidated,promoCode:code,promoAttemptError:null});
    },
    removePromo: () => { if(!pending) patch({...invalidated,promoCode:'',promoAttemptError:null}); },
    change: (update: Partial<Pick<State, 'method' | 'branch' | 'asap' | 'day' | 'selectedAddress' | 'split'>>) => { if (!pending) patch({ ...invalidated, ...update }); },
    invalidate: () => { if (!pending) patch(invalidated); },
    openAddress: () => { if (!pending) patch({ addressOpen: true, addressId: '', error: null }); },
    editAddress: (id: string) => { if (!pending) patch({addressOpen:true,addressId:id,error:null}); },
    closeAddress: () => patch({ addressOpen: false }),
    saveAddress: (address: NativeAddress) => {
      if (pending || !validDeliveryPin(address.latitude, address.longitude) || !address.street.trim()) return false;
      if (s.scenario === 'delivery') { patch({error:'delivery'}); return false; }
      profile.saveNativeAddress(address); patch({ ...invalidated, selectedAddress: address.id, addressOpen: false }); return true;
    },
    selectScenario: (scenario: CheckoutScenario) => { if (!pending) patch({ ...invalidated, scenario, stockId: scenario === 'stock' ? cart.lines[0]?.product.id || '' : '', verified: scenario !== 'verification' }); },
    selectStockItem: (id: string) => { if (!pending) patch({...invalidated,stockId:id}); },
    expireQuote: () => { if (quote && !pending) patch({quote:{...quote, expires:Date.now()-1}}); },
    changeQuantity: (id: string, quantity: number) => { if (pending) return; patch(invalidated); if (quantity <= 0) cart.remove(id); else cart.quantity(id,quantity); },
    reset: () => { confirmationLock.current = false; setSaved(fresh(merchant)); },
    verify: () => patch({ verified: true, scenario: s.scenario === 'verification' ? 'none' : s.scenario, error: null }),
    checkAvailability, review, place,
    selectWindow: (group: string, value: string) => { if (!pending) patch({ windows: {...s.windows, [group]:value}, quote:null,error:null }); },
    clearOrders: () => { if (!pending) { setOrders([]); patch({detailId:'',confirmed:false}); } },
    selectOrder: (id: string) => patch({detailId:id}),
    cancelOrder: (id: string, reason: CancellationReason, prepaid: boolean) => {
      if (pending || !['changed_mind','wrong_items','wrong_address','other'].includes(reason)) return;
      setOrders(current => current.map(order => order.id === id && canCancelOrder(order) ? {...order, cancellation: {reason, prepaid, date: Date.now(), updated: Date.now(), refund: prepaid ? 'pending' : 'not_required'}} : order));
    },
    refundOrder: (id: string, next: 'pending' | 'failed' | 'refunded') => {
      if (pending) return;
      setOrders(current => current.map(order => {
        const c = order.cancellation;
        if (order.id !== id || !c?.prepaid || !(c.refund === 'pending' && ['failed','refunded'].includes(next) || c.refund === 'failed' && next === 'pending')) return order;
        return {...order,cancellation:{...c,refund:next,updated:Date.now()}};
      }));
    },
    reorder: (lines: CartLine[]) => { if (!pending) { patch(invalidated); cart.addLines(lines); } },
    refreshStatus: () => {
      if (!detail) return;
      setOrders(current => current.map(order => {
        if (order.id !== detail.id || order.cancellation) return order;
        const statuses = orderStages(order.method);
        const next = statuses[statuses.indexOf(order.history.at(-1)!.status)+1];
        return next ? {...order, history:[...order.history,{status:next,date:Date.now()}]} : order;
      }));
    },
  };
}
export type NativeCheckout = ReturnType<typeof useNativePreviewCheckout>;
