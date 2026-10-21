import type { EntityResponse } from "./entity-id";
import { entityInput } from "./entity-id";
import createClient from "openapi-fetch";
import type { components, paths } from "./schema";
import { ApiError } from "./identity";
import { traceFetch } from "./telemetry";
const http=createClient<paths>({baseUrl:"/api",credentials:"include",fetch:traceFetch});
const header={"X-Commerce-Request":"1" as const};
async function unwrap<T>(request:Promise<{data?:T;error?:{error:string};response:Response}>):Promise<T>{
 const r=await request;
 if(!r.response.ok || r.data===undefined) throw new ApiError(r.error?.error ?? "Request failed",r.response.status);
 return r.data;
}
export type InventorySource = EntityResponse<components["schemas"]["InventorySource"]>;
export type InventorySourceInput=components["schemas"]["InventorySourceInput"];
export type StockPool = EntityResponse<components["schemas"]["StockPool"]>;
export type StockPoolInput=components["schemas"]["StockPoolInput"];
export type SourceItem=components["schemas"]["SourceItem"];
export const msiApi={
 sources:()=>unwrap(http.GET("/v1/admin/inventory/sources")),
 saveSource:(body:InventorySourceInput,id?:string)=>id?unwrap(http.PUT("/v1/admin/inventory/sources/{id}",{params:{path:{id},header},body:entityInput(body)})):unwrap(http.POST("/v1/admin/inventory/sources",{params:{header},body:entityInput(body)})),
 deleteSource:(id:string)=>unwrap(http.DELETE("/v1/admin/inventory/sources/{id}",{params:{path:{id},header}})),
 stocks:()=>unwrap(http.GET("/v1/admin/inventory/stocks")),
 saveStock:(body:StockPoolInput,id?:string)=>id?unwrap(http.PUT("/v1/admin/inventory/stocks/{id}",{params:{path:{id},header},body:entityInput(body)})):unwrap(http.POST("/v1/admin/inventory/stocks",{params:{header},body:entityInput(body)})),
 deleteStock:(id:string)=>unwrap(http.DELETE("/v1/admin/inventory/stocks/{id}",{params:{path:{id},header}})),
 items:(id:string)=>unwrap(http.GET("/v1/admin/inventory/{id}/sources",{params:{path:{id}}})),
 adjust:(id:string,body:components["schemas"]["SourceItemInput"])=>unwrap(http.PUT("/v1/admin/inventory/{id}/sources",{params:{path:{id},header},body})),
 shipmentStatus:(id:string,status:"delivered"|"delivery_failed",reason:string)=>unwrap(http.POST("/v1/admin/shipments/{id}/status",{params:{path:{id},header},body:{status,reason}})),
};
