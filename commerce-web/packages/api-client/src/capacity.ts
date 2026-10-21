import { assistantHeaders, withCustomerSession, ApiError } from './identity';
import { traceFetch } from './telemetry';
import { entityInput } from './entity-id';
export interface DeliverySlot { schedule_id: string; source_id: string; method: string; timezone: string; starts_at: string; ends_at: string; availability: string }
export interface ScheduleWindow { weekday: number; start: string; end: string; cutoff: string | null }
export interface ScheduleConfig { selection_required?: boolean; windows: ScheduleWindow[]; duration_minutes: number | null; spacing_minutes: number; lead_minutes: number; cutoff: string | null; min_days: number; max_days: number; ttl_minutes: number; release_before: string; exceptions: { from: string; through: string; closed: boolean; windows: ScheduleWindow[] }[] }
export interface FulfillmentSchedule { id: string; readonly entity_id?: number; source_id: string; area_id: string | null; method: string; enabled: boolean; timezone: string; config: ScheduleConfig }
export interface CapacityRule { id: string; readonly entity_id?: number; overrides_rule_id: string | null; source_id: string | null; area_id: string | null; method: string | null; timezone: string; local_start: string | null; period: string; limits: Record<string, number>; overflow_percent: number; starts_on: string | null; ends_on: string | null; enabled: boolean }
export interface CapacityConfiguration { legacy_controls?:boolean; controls?:{capacity:boolean;scheduling:boolean;pickup:boolean;geofencing:boolean}; enabled: boolean; schedules: FulfillmentSchedule[]; rules: CapacityRule[]; sources: [string,string][]; areas: [string,string][] }
export interface CapacityRow { slot: DeliverySlot; area_id: string | null; reserved: number; confirmed: number; utilization: number; status: string; caps: { rule_id: string; period: string; dimension: string; limit: number; effective: number; used: number; remaining: number }[] }
export interface CapacityHold { id: string; readonly entity_id?: number; status: string; expires_at: string; source_id: string; method: string; starts_at: string; ends_at: string }
export async function capacityRequest<T>(path: string, body?: unknown, method = body ? 'POST' : 'GET'): Promise<T> {
  const response = await traceFetch('/api/v1/' + path, { method, credentials: 'include', headers: assistantHeaders(), ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new ApiError(value.error || 'Delivery service unavailable', response.status), { code: value.code, status: response.status });
  return value as T;
}
export const capacityApi = {
  setEnabled: (enabled: boolean, reason: string) => capacityRequest('admin/fulfillment/settings', { enabled, reason }),
  configuration: () => capacityRequest<CapacityConfiguration>('admin/fulfillment/configuration'),
  overview: (date: string) => capacityRequest<{ date: string; slots: CapacityRow[] }>('admin/fulfillment/capacity?date=' + encodeURIComponent(date)),
  saveSchedule: (schedule: FulfillmentSchedule, reason: string) => capacityRequest('admin/fulfillment/schedules', { schedule: entityInput(schedule), reason }),
  saveRule: (rule: CapacityRule, reason: string, acknowledge_existing_bookings: boolean) => capacityRequest('admin/fulfillment/capacity-rules', { rule: entityInput(rule), reason, acknowledge_existing_bookings }),
  options: (location: string, date: string) => withCustomerSession(() => capacityRequest<{ enabled: boolean; slots: DeliverySlot[] }>(`fulfillment/delivery-options?location_id=${encodeURIComponent(location)}&date=${encodeURIComponent(date)}`)),
  hold: (slot: DeliverySlot, location_id: string, idempotency_key: string) => withCustomerSession(() => capacityRequest<CapacityHold>('fulfillment/reservations', { schedule_id: slot.schedule_id, starts_at: slot.starts_at, ends_at: slot.ends_at, location_id, idempotency_key })),
  release: (id: string) => withCustomerSession(() => capacityRequest('fulfillment/reservations/' + encodeURIComponent(id), undefined, 'DELETE')),
};
export interface FulfillmentCapabilities {
  delivery_enabled:boolean; pickup_enabled:boolean; scheduled_delivery_enabled:boolean; asap_delivery_enabled:boolean;
  capacity_management_enabled:boolean; checkout_capacity_holds_enabled:boolean; geo_fencing_enabled:boolean; global_delivery_enabled:boolean;
  multi_source_fulfillment_enabled:boolean; split_order_scheduling_enabled:boolean; automatic_source_routing_enabled:boolean;
  customer_delivery_slot_selection_enabled:boolean; admin_manual_scheduling_enabled:boolean; pickup_scheduling_enabled:boolean;
  split_delivery_mode:'same_window_required'|'independent_windows'; delivery_city_ids:string[];
}
export interface FulfillmentRequest { method:'delivery'|'pickup';location_id:string|null;source_id:string|null;date:string;asap:boolean }
export interface FulfillmentGroup { source_id:string;source_name:string;items:{product_id:string;quantity:number}[];slots:DeliverySlot[] }
export interface FulfillmentPlan {id:string;readonly entity_id?:number;method:string;store_id:string;location_id:string|null;status:string;expires_at:string;groups:(FulfillmentGroup & {id:string;readonly entity_id?:number;starts_at:string;ends_at:string;timezone:string;schedule_id:string|null})[]}
export interface FulfillmentAvailability {store_id:string;capabilities:FulfillmentCapabilities;methods:{type:'delivery'|'pickup';scheduling:boolean;asap?:boolean;locations?:{id:string;name:string;instructions:string;preparation_minutes:number}[]}[]}
export interface FulfillmentSettings {system:Partial<FulfillmentCapabilities>;stores:{id:string;readonly entity_id?:number;name:string;overrides:Partial<FulfillmentCapabilities>;resolved:FulfillmentCapabilities}[];locations:{id:string;name:string}[];sources:{store_id:string;source_id:string;pickup_enabled:boolean;pickup_instructions:string;preparation_minutes:number}[]}
export const fulfillmentPlanApi = {
 capabilities:()=>capacityRequest<FulfillmentCapabilities>('fulfillment/capabilities'),
 availability:()=>withCustomerSession(()=>capacityRequest<FulfillmentAvailability>('fulfillment/availability')),
 options:(request:FulfillmentRequest)=>withCustomerSession(()=>capacityRequest<{capabilities:FulfillmentCapabilities;groups:FulfillmentGroup[];common_windows:[string,string][]}>('fulfillment/plan-options',request)),
 reserve:(request:FulfillmentRequest,windows:DeliverySlot[],idempotency_key:string)=>withCustomerSession(()=>capacityRequest<FulfillmentPlan>('fulfillment/plans',{request,windows:windows.map(({source_id,schedule_id,starts_at,ends_at})=>({source_id,schedule_id,starts_at,ends_at})),idempotency_key})),
 release:(id:string)=>withCustomerSession(()=>capacityRequest('fulfillment/plans/'+id,undefined,'DELETE')),
 settings:()=>capacityRequest<FulfillmentSettings>('admin/fulfillment/capabilities'),
 saveSettings:(store_id:string|null,capabilities:Partial<FulfillmentCapabilities>,reason:string)=>capacityRequest('admin/fulfillment/capabilities',{store_id,capabilities,reason}),
 saveStore:(id:string,name:string,reason:string,branch?:{address:string;delivery_enabled:boolean;pickup_enabled:boolean;stock_id?:string})=>capacityRequest('admin/fulfillment/stores',{id,name,reason,...(branch?{branch}:{})}),
 saveSource:(source:FulfillmentSettings['sources'][number],reason:string)=>capacityRequest('admin/fulfillment/store-sources',{...source,reason}),
 stores:()=>capacityRequest<{id:string;readonly entity_id?:number;name:string;is_default:boolean}[]>('fulfillment/stores'),
 selectStore:(store_id:string)=>withCustomerSession(()=>capacityRequest('fulfillment/store',{store_id})),
};
