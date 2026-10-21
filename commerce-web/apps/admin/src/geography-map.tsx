import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './order-geo.css';

export type GeographyMarker = { key: string; latitude: number; longitude: number; avatar: string; title: string; count: number };

export function GeographyMap({ points, selected, onSelect, label }: { points: GeographyMarker[]; selected: string; onSelect: (key: string) => void; label: string }) {
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map>();
  const select = useRef(onSelect);
  select.current = onSelect;
  const [tileError, setTileError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!element.current) return;
    const instance = L.map(element.current, { scrollWheelZoom: false }).setView([30.0444, 31.2357], 6);
    map.current = instance;
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(instance);
    tiles.on('tileerror', () => setTileError(true));
    const resize = new ResizeObserver(() => instance.invalidateSize());
    resize.observe(element.current);
    return () => { resize.disconnect(); instance.remove(); map.current = undefined; };
  }, [revision]);
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const layer = L.layerGroup().addTo(instance);
    for (const point of points) {
      const avatar = document.createElement('span');
      avatar.className = 'order-geo-avatar';
      avatar.textContent = point.avatar;
      if (point.count > 1) {
        const badge = document.createElement('small');
        badge.textContent = String(point.count);
        avatar.append(badge);
      }
      L.marker([point.latitude, point.longitude], {
        title: point.title,
        keyboard: true,
        icon: L.divIcon({ className: 'order-geo-marker', html: avatar, iconSize: [42, 48], iconAnchor: [21, 48] }),
      }).on('click', () => select.current(point.key)).addTo(layer);
    }
    if (points.length) instance.fitBounds(L.latLngBounds(points.map(point => [point.latitude, point.longitude])), { padding: [40, 40], maxZoom: 14 });
    return () => { layer.remove(); };
  }, [points, revision]);
  useEffect(() => {
    const point = points.find(point => point.key === selected);
    if (point) map.current?.setView([point.latitude, point.longitude], 16);
  }, [selected, points, revision]);
  return <section className="order-geo-map-region" aria-label={label}>
    <div className="order-geo-map-actions"><button type="button" className="secondary" disabled={!points.length} onClick={() => { if (points.length) map.current?.fitBounds(L.latLngBounds(points.map(point => [point.latitude, point.longitude])), { padding: [40, 40], maxZoom: 14 }); }}>Fit locations</button></div>
    <div ref={element} className="order-geo-map" aria-label={label} />
    {tileError && <div className="order-geo-map-error" role="status">Map tiles could not load. Locations are still available in the list. <button className="text-button" onClick={() => { setTileError(false); setRevision(value => value + 1); }}>Retry map</button></div>}
  </section>;
}

