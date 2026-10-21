import { ApiError } from "./identity";
export interface DiscoverySettings {
  revision:number; enabled:boolean; indexing_enabled:boolean; llms_txt_enabled:boolean;
  site_name:string; organization_name:string; canonical_url:string|null; description:string;
  default_locale:string; feature_pages_enabled:boolean; industry_pages_enabled:boolean;
  docs_enabled:boolean; pricing_page_enabled:boolean; security_page_enabled:boolean;
  integrations_page_enabled:boolean; changelog_enabled:boolean;
  grocery_demo_url:string|null; jewelry_demo_url:string|null; updated_at:string;
}
export type DiscoverySettingsInput = Omit<DiscoverySettings,"revision"|"updated_at"> & {expected_revision:number};
async function request(method:"GET"|"PUT",body?:DiscoverySettingsInput){
  const response=await fetch("/api/v1/admin/discovery/config",{method,credentials:"include",headers:body?{"content-type":"application/json","X-Commerce-Request":"1"}:undefined,body:body?JSON.stringify(body):undefined});
  const value=await response.json() as DiscoverySettings|{error?:string};
  if(!response.ok) throw new ApiError("error" in value&&value.error?value.error:"Request failed ("+response.status+")",response.status);
  return value as DiscoverySettings;
}
export const discoverabilityApi={get:()=>request("GET"),save:(body:DiscoverySettingsInput)=>request("PUT",body)};

export type EffectiveIndexingPolicy = import('./schema').components['schemas']['EffectiveIndexingPolicy'];
export async function effectiveIndexingPolicy(): Promise<EffectiveIndexingPolicy> {
  const response = await fetch('/api/v1/admin/discovery/effective', { credentials: 'include', cache: 'no-store' });
  if (!response.ok) throw new ApiError('Unable to load effective indexing policy', response.status);
  return response.json() as Promise<EffectiveIndexingPolicy>;
}
