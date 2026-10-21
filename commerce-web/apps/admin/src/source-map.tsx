import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
export function SourceMap({latitude,longitude,onChange}:{latitude:number|null;longitude:number|null;onChange:(latitude:number,longitude:number)=>void}) {
 const element=useRef<HTMLDivElement>(null),map=useRef<L.Map>(),marker=useRef<L.Marker>(),change=useRef(onChange);
 change.current=onChange;
 useEffect(()=>{
  if(!element.current)return;
  const m=L.map(element.current,{scrollWheelZoom:false}).setView([30.0444,31.2357],10);map.current=m;
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(m);
  m.on("click",(e:L.LeafletMouseEvent)=>change.current(e.latlng.lat,e.latlng.lng));
  return()=>{m.remove();map.current=undefined;marker.current=undefined;};
 },[]);
 useEffect(()=>{
  const m=map.current;
  if(!m)return;
  if(latitude===null||longitude===null||!Number.isFinite(latitude)||!Number.isFinite(longitude)||Math.abs(latitude)>90||Math.abs(longitude)>180){marker.current?.remove();marker.current=undefined;return;}
  const point:L.LatLngTuple=[latitude,longitude];
  if(!marker.current){
   const pin=L.marker(point,{draggable:true,title:"Source location",icon:L.divIcon({className:"source-map-pin",html:'<span style="display:block;width:20px;height:20px;border:3px solid white;border-radius:50%;background:#176b57;box-shadow:0 1px 5px #555"></span>',iconSize:[26,26],iconAnchor:[13,13]})}).addTo(m);
   pin.on("dragend",()=>{const p=pin.getLatLng();change.current(p.lat,p.lng);});marker.current=pin;
  }else marker.current.setLatLng(point);
  m.setView(point,Math.max(m.getZoom(),13));
 },[latitude,longitude]);
 return <div ref={element} style={{height:300,borderRadius:12,marginBottom:16}} aria-label="Source location map. Click to place the pin or enter coordinates."/>;
}
