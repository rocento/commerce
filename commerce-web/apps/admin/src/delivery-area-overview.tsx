import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import type { DeliveryArea } from '@commerce/api-client';
import { deliveryAreaColor, deliveryGeometry } from './delivery-geometry';

type Props = { areas: DeliveryArea[]; stocks: { id: string; name: string }[]; canWrite: boolean; onOpen: (area: DeliveryArea) => void };
export function DeliveryAreaOverview({ areas, stocks, canWrite, onOpen }: Props) {
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map>();
  const group = useRef<L.FeatureGroup>();
  const shapes = useRef(new Map<string, L.Polygon | L.Circle>());
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<string>();
  const [tileError, setTileError] = useState(false);
  const visible = useMemo(() => areas.filter(area => filter === 'all' || area.is_active === (filter === 'active')), [areas, filter]);
  const selectedArea = visible.find(area => area.id === selected);
  const unmapped = visible.filter(area => !deliveryGeometry(area)).length;
  function fitAll() {
    const bounds = group.current?.getBounds();
    if (bounds?.isValid()) map.current?.fitBounds(bounds, { padding: [32, 32], maxZoom: 14 });
  }
  function select(area: DeliveryArea) {
    setSelected(area.id);
    const shape = shapes.current.get(area.id);
    if (shape) { map.current?.fitBounds(shape.getBounds(), { padding: [48, 48], maxZoom: 14 }); shape.openTooltip(); }
  }
  useEffect(() => {
    if (!element.current) return;
    const shapeIndex = shapes.current;
    const instance = L.map(element.current).setView([30.0444, 31.2357], 10);
    map.current = instance;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).on('tileerror', () => setTileError(true)).addTo(instance);
    group.current = L.featureGroup().addTo(instance);
    const resize = new ResizeObserver(() => instance.invalidateSize());
    resize.observe(element.current);
    return () => { resize.disconnect(); instance.remove(); map.current = undefined; group.current = undefined; shapeIndex.clear(); };
  }, []);
  useEffect(() => {
    const layer = group.current;
    if (!layer) return;
    layer.clearLayers(); shapes.current.clear();
    visible.forEach(area => {
      const geometry = deliveryGeometry(area);
      if (!geometry) return;
      const options: L.PathOptions = { color: deliveryAreaColor(area.id), weight: 2, fillOpacity: area.is_active ? .16 : .05, dashArray: area.is_active ? undefined : '7 5' };
      const shape = geometry.kind === 'polygon' ? L.polygon(geometry.points, options) : L.circle(geometry.center, { ...options, radius: geometry.radius });
      // Use text nodes: area names are merchant-provided, not trusted HTML.
      const tooltip = document.createElement('span');
      tooltip.textContent = `${area.name} · ${area.is_active ? 'Active' : 'Inactive'} · Priority ${area.priority}`;
      shape.bindTooltip(tooltip, { sticky: true }).on('click', () => setSelected(area.id)).addTo(layer);
      shapes.current.set(area.id, shape);
    });
    fitAll();
  }, [visible]);
  useEffect(() => {
    shapes.current.forEach((shape, id) => { shape.setStyle({ weight: id === selected ? 4 : 2 }); if (id === selected) shape.bringToFront(); });
  }, [selected, visible]);
  return <section className="delivery-overview" aria-labelledby="delivery-overview-heading">
    <div className="delivery-overview-heading"><div><h2 id="delivery-overview-heading">Delivery coverage overview</h2><p>All delivery areas on one map. Select an area to inspect its boundary and stock assignments.</p></div><button type="button" className="secondary" disabled={visible.length === unmapped} onClick={fitAll}>Fit all areas</button></div>
    <div className="delivery-overview-controls"><label>Map coverage <select value={filter} onChange={event => { setFilter(event.target.value); setSelected(undefined); }}><option value="all">All areas</option><option value="active">Active areas</option><option value="inactive">Inactive areas</option></select></label><span><i className="delivery-line"/>Active</span><span><i className="delivery-line is-inactive"/>Inactive</span><span role="status">{visible.length - unmapped} of {areas.length} areas on map</span></div>
    {tileError && <p className="help" role="status">The base map could not be fully loaded. Coverage boundaries and area details remain available.</p>}
    {unmapped > 0 && <p className="help" role="status">{unmapped} {unmapped === 1 ? 'area has' : 'areas have'} no valid boundary and cannot be drawn. Open the area to review its coordinates.</p>}
    <div className="delivery-overview-layout"><div ref={element} className="delivery-overview-map" aria-label="Map of all delivery areas"/><aside className="delivery-overview-areas" aria-label="Delivery areas on map">
      {!visible.length && <p>No delivery areas match this map filter.</p>}
      <div className="delivery-area-legend">{visible.map(area => <button type="button" key={area.id} className={selected === area.id ? 'selected' : ''} aria-pressed={selected === area.id} onClick={() => select(area)}><i style={{ background: deliveryAreaColor(area.id) }}/><span><strong>{area.name}</strong><small>{area.is_active ? 'Active' : 'Inactive'} · Priority {area.priority}{!deliveryGeometry(area) ? ' · No boundary' : ''}</small></span></button>)}</div>
      {selectedArea && <div className="delivery-overview-detail"><h3>{selectedArea.name}</h3><p>{selectedArea.is_active ? 'Active for delivery' : 'Inactive for delivery'}</p><dl><dt>Priority</dt><dd>{selectedArea.priority}</dd><dt>Boundary</dt><dd>{selectedArea.boundary?.length ? `${selectedArea.boundary.length} polygon points` : `${selectedArea.radius_km} km radius`}</dd><dt>Assigned stocks</dt><dd>{selectedArea.stocks.length ? selectedArea.stocks.map(link => stocks.find(stock => stock.id === link.stock_id)?.name || 'Assigned stock').join(', ') : 'None assigned'}</dd></dl><button className="secondary" onClick={() => onOpen(selectedArea)}>{canWrite ? 'Edit delivery area' : 'View delivery area'}</button></div>}
    </aside></div>
    <p className="delivery-overview-note">Solid boundaries are active; dashed boundaries are inactive. Lower priority numbers win where areas overlap. Map coverage is independent of the table’s filters and pagination.</p>
  </section>;
}
