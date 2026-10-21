import { useInterface } from './interface-locale';
import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Notice } from "@commerce/ui";

export default function MapPin({
  latitude,
  longitude,
  onChange,
}: {
  latitude: number;
  longitude: number;
  onChange: (lat: number, lon: number) => void;
}) {
  const { message } = useInterface();
  const { t: ui } = useInterface();
  const element = useRef<HTMLDivElement>(null),
    map = useRef<L.Map | null>(null),
    marker = useRef<L.Marker | null>(null),
    change = useRef(onChange);
  change.current = onChange;
  const [error, setError] = useState("");
  const [locating, setLocating] = useState(false);
  const initial = useRef({ latitude, longitude });
  useEffect(() => {
    if (!element.current) return;
    const value = initial.current;
    const valid =
      Number.isFinite(value.latitude) && Number.isFinite(value.longitude);
    const m = L.map(element.current, { scrollWheelZoom: false }).setView(
      valid ? [value.latitude, value.longitude] : [30.0444, 31.2357],
      valid ? 16 : 11,
    );
    map.current = m;
    const tiles = L.tileLayer(
      import.meta.env.VITE_MAP_TILE_URL ||
        "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      {
        maxZoom: 19,
        attribution:
          import.meta.env.VITE_MAP_ATTRIBUTION ||
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
    ).addTo(m);
    tiles.on("tileerror", () =>
      setError(
        "Map tiles are unavailable. You can still enter coordinates below.",
      ),
    );
    const pick = (point: L.LatLng) => {
      const p = point.wrap();
      change.current(Number(p.lat.toFixed(6)), Number(p.lng.toFixed(6)));
    };
    m.on("click", (e: L.LeafletMouseEvent) => pick(e.latlng));
    const pin = L.marker(
      valid ? [value.latitude, value.longitude] : m.getCenter(),
      {
        draggable: true,
        keyboard: true,
        title: "Delivery pin",
        icon: L.divIcon({
          className: "delivery-marker",
          html: '<span aria-hidden="true">●</span>',
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        }),
      },
    );
    marker.current = pin;
    if (valid) pin.addTo(m);
    pin.on("dragend", () => pick(pin.getLatLng()));
    const resize = new ResizeObserver(() => m.invalidateSize());
    resize.observe(element.current);
    return () => {
      resize.disconnect();
      m.remove();
      map.current = null;
      marker.current = null;
    };
  }, []);
  useEffect(() => {
    const m = map.current,
      pin = marker.current;
    if (m && pin && Number.isFinite(latitude) && Number.isFinite(longitude)) {
      pin.setLatLng([latitude, longitude]).addTo(m);
      if (m.getZoom() < 15 || !m.getBounds().contains([latitude, longitude]))
        m.setView([latitude, longitude], 16);
    }
  }, [latitude, longitude]);
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    for (const [selector,key,text] of [['.leaflet-control-zoom-in','address.zoom_in','Zoom in'],['.leaflet-control-zoom-out','address.zoom_out','Zoom out']]) {
      const control=m.getContainer().querySelector(selector);control?.setAttribute('title',ui(key,text));control?.setAttribute('aria-label',ui(key,text));
    }
    const element = marker.current?.getElement();
    if (element) {element.setAttribute('title',ui('address.delivery_pin','Delivery pin'));element.setAttribute('aria-label',ui('address.delivery_pin','Delivery pin'));}
  }, [ui, latitude, longitude]);
  return (
    <section className="location-picker">
      <p>{ui("address.map_help", "Tap your building on the map, or drag the pin to the entrance your driver should use.")}</p>
      <div
        ref={element}
        className="delivery-map"
        aria-label={ui("address.map", "Delivery location map")}
      />
      <div className="row">
        <button
          type="button"
          className="secondary"
          onClick={() => {
            const p = map.current?.getCenter().wrap();
            if (p) onChange(Number(p.lat.toFixed(6)), Number(p.lng.toFixed(6)));
          }}
        >
          {ui("address.pin_center", "Pin map center")} </button>
        <button
          type="button"
          className="secondary"
          disabled={locating}
          onClick={() => {
            if (!navigator.geolocation) {
              setError("Location access is not available in this browser.");
              return;
            }
            setLocating(true);
            navigator.geolocation.getCurrentPosition(
              (p) => {
                onChange(
                  Number(p.coords.latitude.toFixed(6)),
                  Number(p.coords.longitude.toFixed(6)),
                );
                setError("");
                setLocating(false);
              },
              () => {
                setError(
                  "Could not access your location. Drop a pin or enter coordinates instead.",
                );
                setLocating(false);
              },
              { timeout: 10000, maximumAge: 60000, enableHighAccuracy: true },
            );
          }}
        >
          {locating ? ui("address.locating", "Finding location…") : ui("address.current_location", "Use my current location")}
        </button>
      </div>
      <Notice error>{message((error) || '')}</Notice>
      <p className="help">
        {ui("address.permission", "Your browser will ask for permission before using your current location.")} </p>
    </section>
  );
}
