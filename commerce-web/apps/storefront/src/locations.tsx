import { hasDeliveryAddress } from "./delivery-requirement";
import { useInterface } from './interface-locale';
import {fulfillmentPlanApi, deliveryApi, setDeliveryPin} from "@commerce/api-client";
import { lazy, Suspense, useEffect, useId, useState } from "react";
import { useDeliveryKey } from './use-delivery-key';
export { useDeliveryKey } from './use-delivery-key';
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  customerApi,
  type Customer,
  type LocationInput,
  type Location,
  locationAddress,
} from "@commerce/api-client";
import { Field, Notice, useAction } from "@commerce/ui";
import {
  deliveryLabel,
  deliveryPinForHeader,
  selectDeliveryLocation,
  shouldRefreshForDelivery,
} from "./locations-logic";
import "./locations.css";
import { clearDeliverySelection, deliveryCountries, selectDeliveryCountry, emptyGeography, geographyLabel, loadDeliveryCities, loadDeliveryDirectory, selectDeliveryCity } from "./delivery-geography";
import { CitySelect } from './city-select';
const draftKey = "commerce-guest-location";
export const emptyDelivery: LocationInput = {
  location_method: "pin",
  geography: null,
  label: "home",
  custom_label: "",
  latitude: NaN,
  longitude: NaN,
  formatted_address: "",
  building: "",
  floor: "",
  apartment: "",
  delivery_instructions: "",
  is_default: false,
};
function draft(): LocationInput | null {
  try {
    const d = JSON.parse(sessionStorage.getItem(draftKey) || "null");
    return d &&
      typeof d.formatted_address === "string" &&
      Number.isFinite(d.latitude) &&
      Number.isFinite(d.longitude)
      ? d
      : null;
  } catch {
    return null;
  }
}
export function useActiveLocation(owner: string) {
  const key = "commerce-active-location:" + owner;
  const [id, setId] = useState(() => sessionStorage.getItem(key) || "");
  useEffect(() => {
    const update = () => setId(sessionStorage.getItem(key) || "");
    update();
    window.addEventListener("commerce-location", update);
    return () => window.removeEventListener("commerce-location", update);
  }, [key]);
  return [
    id,
    (next: string) => {
      sessionStorage.setItem(key, next);
      setId(next);
      window.dispatchEvent(new Event("commerce-location"));
    },
  ] as const;
}
export function SavedAddressList({ addresses, selectedId, onSelect, disabled = false }: { addresses: Location[]; selectedId?: string; onSelect: (id: string) => void; disabled?: boolean }) {
  const { t: ui } = useInterface();
  const name = useId();
  return <fieldset className="saved-address-list" disabled={disabled}>
    <legend className="sr-only">{ui("storefront.saved_addresses", "Saved addresses")}</legend>
    {addresses.map(address => <label key={address.id} className="saved-address-option" data-selected={selectedId === address.id}>
      <input type="radio" name={name} checked={selectedId === address.id} onChange={() => onSelect(address.id)} />
      <span className="saved-address-details">
        <span className="saved-address-title"><strong>{address.custom_label || (address.label.toLowerCase() === "home" ? ui("address.home","Home") : address.label.toLowerCase() === "work" ? ui("storefront.work","Work") : ui("storefront.other","Other"))}</strong>{address.is_default && <small>{ui("storefront.default", "Default")}</small>}</span>
        <span>{locationAddress(address)}</span>
        <span>{[address.building && ui("address.building_value", "Building {value}", {value:address.building}), address.floor && ui("address.floor_value", "Floor {value}", {value:address.floor}), address.apartment && ui("address.apartment_value", "Apartment {value}", {value:address.apartment})].filter(Boolean).join(' · ')}</span>
        {address.delivery_instructions && <span className="saved-address-instructions">{address.delivery_instructions}</span>}
        <strong className="saved-address-selection">{selectedId === address.id ? ui("storefront.deliver_here", "Deliver here") : ui("storefront.select_address", "Select address")}</strong>
      </span>
    </label>)}
  </fieldset>;
}
const LazyMapPin = lazy(() => import("./map-pin"));
export function MapPin(props: { latitude: number; longitude: number; onChange: (lat: number, lon: number) => void }) {
  const { t: ui } = useInterface();
  return <Suspense fallback={<div className="delivery-map" role="status">{ui("storefront.loading_map", "Loading map…")}</div>}>
    <LazyMapPin {...props} />
  </Suspense>;
}
export function DeliveryFields({
  value,
  onChange,
  showDefault = true,
  onBrowseLocation,
}: {
  value: LocationInput;
  onChange: (v: LocationInput) => void;
  showDefault?: boolean;
  onBrowseLocation?: (location: LocationInput) => void;
}) {
  const { t: ui, message } = useInterface();
  const headingId = useId();
  const capabilities=useQuery({queryKey:['public-fulfillment-capabilities'],queryFn:fulfillmentPlanApi.capabilities,retry:false});
  const geo=capabilities.data?.global_delivery_enabled || capabilities.data?.geo_fencing_enabled!==false;
  const method = geo ? value.location_method ?? "pin" : "neighborhood";
  const geography = value.geography;
  const countryCode = geography?.country_code || "";
  const country = deliveryCountries.find(item => item.code === countryCode);
  const rawStateLabel = country?.stateLabel ?? "State / Region";
  const stateLabel = message(rawStateLabel);
  const directory = useQuery({ queryKey: ["delivery-geography", countryCode], queryFn: ({ signal }) => loadDeliveryDirectory(countryCode, signal), enabled: method === "neighborhood" && !!country, staleTime: Infinity });
  const stateCode = geography?.state_code || "";
  const cities = useQuery({ queryKey: ["delivery-cities", countryCode, stateCode], queryFn: ({ signal }) => loadDeliveryCities(stateCode, countryCode, signal), enabled: method === "neighborhood" && !!country && !!stateCode && !!directory.data?.states.some(state => state.code === stateCode), staleTime: Infinity });
  const selectedState = directory.data?.states.find(state => state.code === stateCode);
  const reset = () => clearDeliverySelection(value, "neighborhood");
  return (
    <>
      <section className="delivery-step" aria-labelledby={headingId}>
        <div className="delivery-step-heading"><div><h3 id={headingId}>{ui("storefront.choose_how_to_set_your_location", "Choose how to set your location")}</h3><p>{ui("storefront.select_one_option_then_add_your_street_and_building_details", "Select one option, then add your street and building details.")}</p></div></div>
        <fieldset className="delivery-methods">
          <legend className="sr-only">{ui("storefront.delivery_location_method", "Delivery location method")}</legend>
          {([['pin', ui("storefront.pin_your_building_entrance", "Pin your building entrance"), ui("storefront.use_the_map_or_your_current_location", "Use the map or your current location")], ['neighborhood', ui("storefront.choose_your_neighborhood", "Choose your neighborhood"), ui("storefront.country_region_and_city", "Country, region and city")]] as const).filter(([id])=>geo||id!=='pin').map(([id, title, help]) => <label key={id} className="delivery-method" data-selected={method === id}>
            <input type="radio" name={headingId + '-method'} value={id} checked={method === id} onChange={() => onChange(clearDeliverySelection(value, id))} />
            <span><strong>{title}</strong><small>{help}</small></span>
          </label>)}
        </fieldset>
        {method === "neighborhood" ? <div className="delivery-neighborhood">
          <div className="delivery-geography-fields">
            <label className="field"><span>{ui("storefront.country", "Country")}</span><select aria-label={ui("storefront.country", "Country")} required value={geography?.country_code || ""} onChange={e => onChange(selectDeliveryCountry(value, e.target.value))}>
              <option value="">{ui("storefront.choose_country", "Choose country")}</option>
              {deliveryCountries.map(item => <option key={item.code} value={item.code}>{item.name}{item.name_ar ? ` — ${item.name_ar}` : ""}</option>)}
            </select></label>
            <label className="field"><span>{stateLabel}</span><select aria-label={stateLabel} required value={stateCode} disabled={!geography?.country_code || !directory.data} onChange={e => {
              const state = directory.data?.states.find(item => item.code === e.target.value);
              onChange({ ...reset(), geography: { ...emptyGeography(geography?.country_code), state_code: state?.code || "", state_name: state?.name || "" } });
            }}><option value="">{country && directory.isPending ? ui("storefront.loading_regions", "Loading regions…") : ui("address.choose_region", "Choose {region}", {region:stateLabel.toLowerCase()})}</option>{directory.data?.states.map(state => <option key={state.code} value={state.code}>{state.name}{state.name_ar ? ` — ${state.name_ar}` : ""}</option>)}</select></label>
          </div>
          <CitySelect key={`${countryCode}:${stateCode}`} cities={cities.data ?? []} selectedId={geography?.city_id} selectedName={geography?.city_name} disabled={!stateCode || cities.isPending || !!cities.error} placeholder={!stateCode ? ui("address.region_first", "Choose {region} first", {region:stateLabel.toLowerCase()}) : cities.isPending ? ui("address.loading_cities", "Loading cities...") : ui("address.search_city", "Search city or neighborhood")} onSelect={city => {
            if (city && selectedState) onChange(selectDeliveryCity(value, selectedState, city));
            else onChange({ ...clearDeliverySelection(value, "neighborhood"), geography: geography ? { ...geography, city_id: "", city_name: "" } : null });
          }} />
          {(directory.error || cities.error) && <div role="alert"><p className="field-error">{ui("storefront.the_location_list_could_not_be_loaded_retry_or_choose_a_map_pin", "The location list could not be loaded. Retry or choose a map pin.")}</p><button type="button" className="secondary" onClick={() => { if (directory.error) void directory.refetch(); if (cities.error) void cities.refetch(); }}>{ui("storefront.retry_location_list", "Retry location list")}</button></div>}
          <p className="help">{ui("storefront.no_pin_is_needed_for_this_option_availability_uses_an_approximate_area_location_your_street_and_buil", "No pin is needed for this option. Availability uses an approximate area location; your street and building details guide the driver.")}</p>
          <p className="delivery-data-credit">{ui("storefront.location_data", "Location data:")} <a href="https://www.geonames.org/" target="_blank" rel="noreferrer">GeoNames</a>, <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>{ui("storefront.includes_cities_towns_villages_and_neighborhoods", ". Includes cities, towns, villages and neighborhoods.")}</p>
          {onBrowseLocation && geography?.city_id && <div className="delivery-browse"><button type="button" className="secondary" onClick={() => onBrowseLocation({ ...value, formatted_address: geographyLabel(value) })}>{ui("storefront.browse_products_in_this_area", "Browse products in this area")}</button><p className="help">{ui("storefront.add_your_street_address_before_ordering", "Add your street address before ordering.")}</p></div>}
        </div> : <div className="delivery-pin-choice">
          <MapPin latitude={value.latitude} longitude={value.longitude} onChange={(latitude, longitude) => onChange({ ...value, location_method: "pin", geography: null, latitude, longitude })} />
        </div>}
      </section>
      <section className="delivery-step delivery-address-step">
        <div className="delivery-step-heading"><div><h3>{ui("storefront.add_your_address_details", "Add your address details")}</h3><p>{ui("storefront.include_your_street_and_building_then_any_details_that_help_your_driver_find_you", "Include your street and building, then any details that help your driver find you.")}</p></div></div>
      <label className="field">
        <span>{ui("storefront.save_this_address_as", "Save this address as")}</span>
        <select
          value={value.label}
          onChange={(e) =>
            onChange({
              ...value,
              label: e.target.value as LocationInput["label"],
            })
          }
        >
          <option value="home">{ui("address.home", "Home")}</option>
          <option value="work">{ui("storefront.work", "Work")}</option>
          <option value="other">{ui("storefront.other", "Other")}</option>
        </select>
      </label>
      {value.label === "other" && (
        <Field
          label={ui("storefront.custom_label", "Custom label")}
          required
          maxLength={60}
          value={value.custom_label ?? ""}
          onChange={(e) => onChange({ ...value, custom_label: e.target.value })}
        />
      )}
      <Field
        label={ui("address.street", "Street address")}
        placeholder={ui("address.example", "e.g. 15 Road 9, Maadi, Cairo")}
        required
        maxLength={500}
        value={value.formatted_address}
        onChange={(e) =>
          onChange({ ...value, formatted_address: e.target.value })
        }
      />
      {method === "pin" && <details className="delivery-coordinates"><summary>{ui("storefront.enter_map_coordinates_manually", "Enter map coordinates manually")}</summary><div className="form-grid">
        {(["latitude", "longitude"] as const).map((k) => (
          <Field
            key={k}
            label={k === "latitude" ? ui("address.latitude", "Latitude") : ui("address.longitude", "Longitude")}
            type="number"
            step="any"
            min={k === "latitude" ? -90 : -180}
            max={k === "latitude" ? 90 : 180}
            value={Number.isFinite(value[k]) ? value[k] : ""}
            onChange={(e) =>
              onChange({
                ...value,
                [k]: e.target.value === "" ? NaN : Number(e.target.value),
              })
            }
          />
        ))}
      </div></details>}
      <div className="location-unit-row">
      {(["building", "floor", "apartment"] as const).map((k) => (
        <Field
          key={k}
          label={ui(`address.${k}`, k.replaceAll("_", " "))}
          maxLength={k === "building" ? 120 : 40}
          value={value[k] ?? ""}
          onChange={(e) => onChange({ ...value, [k]: e.target.value })}
        />
      ))}
      </div>
      <Field label={ui("address.instructions", "Delivery instructions")} maxLength={1000} value={value.delivery_instructions ?? ""} onChange={(e) => onChange({ ...value, delivery_instructions: e.target.value })} />
      {showDefault && <label className="checkbox">
        <input
          type="checkbox"
          checked={value.is_default ?? false}
          onChange={(e) => onChange({ ...value, is_default: e.target.checked })}
        />
        {ui("storefront.use_as_default_location", "Use as default location")} </label>}
      </section>
    </>
  );
}
export function LocationBar({ customer, onChooseLocation }: { customer: Customer | null; onChooseLocation?: () => void }) {
  return <LocationBarBody key={customer?.id ?? "guest"} customer={customer} onChooseLocation={onChooseLocation} />;
}
function DeliveryIcon() {
  return (
    <svg className="delivery-trigger-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 21s7-5.1 7-11a7 7 0 1 0-14 0c0 5.9 7 11 7 11Z" />
      <circle cx="12" cy="10" r="2.6" />
    </svg>
  );
}
function LocationBarBody({ customer, onChooseLocation }: { customer: Customer | null; onChooseLocation?: () => void }) {
  const { message } = useInterface();
  const { t: ui } = useInterface();
  const route = useLocation();
  const locationLink = route.pathname === "/delivery-location" ? route.pathname + route.search : "/delivery-location?returnTo=" + encodeURIComponent(route.pathname + route.search);
  const [guest, setGuest] = useState(draft);
  useEffect(() => {
    const update = () => setGuest(draft());
    window.addEventListener("commerce-location", update);
    return () => window.removeEventListener("commerce-location", update);
  }, []);
  const cache = useQueryClient();
  const [active] = useActiveLocation(customer?.id ?? "guest");
  const q = useQuery({
    queryKey: ["locations"],
    queryFn: customerApi.locations,
    enabled: !!customer,
  });
  const selected = selectDeliveryLocation(q.data, active);
  const pin = deliveryPinForHeader({ customer, selected, guest });
  const lat = pin?.latitude, lng = pin?.longitude;
  useEffect(()=>{
    setDeliveryPin(lat===undefined||lng===undefined?null:{latitude:lat,longitude:lng});
    void cache.invalidateQueries({
      predicate: (q) => shouldRefreshForDelivery(q.queryKey),
    });
  },[lat,lng,cache]);
  const delivery=useDeliveryStatus();
  const label = deliveryLabel({ customer, selected, guest, fallback: ui("storefront.choose_a_location", "Choose a location") });
  return (
    <div className="delivery-bar">
      {onChooseLocation ? <button type="button" className="delivery-trigger" onClick={onChooseLocation} aria-haspopup="dialog">
        <DeliveryIcon /><span><small>{ui("storefront.deliver_to", "Deliver to")}</small><strong>{label}</strong></span>
      </button> : <Link className="delivery-trigger" to={locationLink}>
        <DeliveryIcon /><span><small>{ui("storefront.deliver_to", "Deliver to")}</small><strong>{label}</strong></span>
      </Link>}
      {pin && delivery.data?.configured && !delivery.data.deliverable && <span className="delivery-status" role="status">{ui("storefront.not_deliverable_here_yet", "Not deliverable here yet")}</span>}
      <Notice error>{message((delivery.error?.message) || '')}</Notice>
    </div>
  );
}
export function DeliveryLocationPage({ customer }: { customer: Customer | null }) {
  return <DeliveryLocationBody key={customer?.id ?? "guest"} customer={customer} />;
}
export function DeliveryLocationPicker({ customer, onComplete, onCancel, newAddress = false, savedOnly = false }: { savedOnly?: boolean; newAddress?: boolean; customer: Customer | null; onComplete: (locationId?: string) => void; onCancel: () => void }) {
  return <DeliveryLocationBody key={customer?.id ?? "guest"} newAddress={newAddress} savedOnly={savedOnly} customer={customer} onComplete={onComplete} onCancel={onCancel} />;
}
function DeliveryLocationBody({ customer, onComplete, onCancel, newAddress = false, savedOnly = false }: { savedOnly?: boolean; newAddress?: boolean; customer: Customer | null; onComplete?: (locationId?: string) => void; onCancel?: () => void }) {
  const { message } = useInterface();
  const { t: ui } = useInterface();
  const route = useLocation(), navigate = useNavigate();
  const requestedReturn = new URLSearchParams(route.search).get("returnTo") || "/";
  const returnTo = /^\/(?:categories\/[a-f0-9-]+|products\/[a-f0-9-]+|search|cart|checkout|assistant)?(?:\?[^#]*)?$/.test(requestedReturn) ? requestedReturn : "/";
  const complete = (locationId?: string) => onComplete ? onComplete(locationId) : navigate(returnTo);
  const [guest, setGuest] = useState(draft);
  const [form, setForm] = useState<LocationInput>(newAddress ? { ...emptyDelivery } : guest ?? { ...emptyDelivery });
  const a = useAction(), cache = useQueryClient();
  const [active, setActive] = useActiveLocation(customer?.id ?? "guest");
  const q = useQuery({
    queryKey: ["locations"],
    queryFn: customerApi.locations,
    enabled: !!customer,
  });
  const [chosen, setChosen] = useState("");
  const selected = selectDeliveryLocation(q.data, chosen || active);
  const pinValid = Number.isFinite(form.latitude) && Number.isFinite(form.longitude) && Math.abs(form.latitude) <= 90 && Math.abs(form.longitude) <= 180;
  const coverage = useQuery({
    queryKey: ["delivery-pin-preview", form.latitude, form.longitude],
    queryFn: () => deliveryApi.check({ latitude: form.latitude, longitude: form.longitude }),
    enabled: pinValid,
    retry: false,
    staleTime: 30000,
  });
  return (
    <div className={`delivery-screen${onComplete ? " delivery-screen-embedded" : ""}`}>
      {!onComplete && <Link to={returnTo} className="back-link"><span className="direction-icon" aria-hidden="true">←</span>  {ui("cart.continue_shopping", "Continue shopping")}</Link>}
      <div className="page-heading">
        <div>
          <p className="eyebrow">{ui("storefront.delivery_location", "DELIVERY LOCATION")}</p>
          {onComplete ? <h2>{newAddress ? ui("storefront.add_a_new_delivery_address", "Add a new delivery address") : savedOnly ? ui("storefront.my_addresses", "My addresses") : ui("storefront.where_should_we_deliver", "Where should we deliver?")}</h2> : <h1>{ui("storefront.where_should_we_deliver", "Where should we deliver?")}</h1>}
          {!savedOnly && <p className="delivery-intro">{ui("storefront.set_your_address_to_see_the_products_available_near_you_and_help_your_driver_find_the_right_entrance", "Set your address to see the products available near you and help your driver find the right entrance.")}</p>}
        </div>
      </div>
      <Notice error>{message((a.error || q.error?.message) || '')}</Notice>
      <Notice>{message((a.message) || '')}</Notice>
      {!savedOnly && !newAddress && customer && guest && (
        <button
          className="text-button"
          onClick={() => {
            setForm(guest);
          }}
        >
          {ui("storefront.save_your_delivery_location", "Save your delivery location")} </button>
      )}
      <div className="delivery-screen-grid">
        <section className="form-card delivery-panel">
          {!newAddress && customer && q.data && q.data.length > 0 && (
            <div className="delivery-saved">
              <h2>{ui("storefront.use_a_saved_address", "Use a saved address")}</h2>
              <SavedAddressList addresses={q.data} selectedId={selected?.id} onSelect={setChosen} />
              <button
                type="button"
                className="secondary"
                disabled={!hasDeliveryAddress(selected) || a.busy}
                onClick={() => {
                  if (!selected) return;
                  void a.run(async () => {
                    setActive(selected.id);
                    setDeliveryPin({ latitude: selected.latitude, longitude: selected.longitude });
                    await cache.invalidateQueries({ predicate: (q) => shouldRefreshForDelivery(q.queryKey) });
                    complete(selected.id);
                  });
                }}
              >
                {ui("storefront.use_saved_location", "Use saved location")} </button>{" "}
              <Link to="/account/locations">
                {ui("storefront.manage_saved_locations", "Manage saved locations")} </Link>
            </div>
          )}
          {savedOnly && !newAddress && <>
            {customer && q.isPending && <p role="status">{ui("storefront.loading_your_addresses", "Loading your addresses…")}</p>}
            {customer && q.isError && <button type="button" className="text-button" onClick={() => void q.refetch()}>{ui("common.retry", "Try again")}</button>}
            {customer && q.isSuccess && !q.data.length && <p>{ui("storefront.you_have_no_saved_addresses_yet", "You have no saved addresses yet.")}</p>}
            {!customer && <p><Link to="/login?next=assistant">{ui("navigation.sign_in", "Sign in")}</Link>  {ui("storefront.to_see_your_saved_addresses", "to see your saved addresses.")}</p>}
          </>}
          {(!savedOnly || newAddress) && <form
            onSubmit={(e) => {
              e.preventDefault();
              void a.run(async () => {
                if (!pinValid || !form.formatted_address.trim()) throw new Error("Choose a country, region and city, or place a pin before saving.");
                let savedLocationId: string | undefined;
                if (customer) {
                  const l = await customerApi.saveLocation(form);
                  savedLocationId = l.id;
                  setActive(l.id);
                  sessionStorage.removeItem(draftKey);
                  setGuest(null);
                  await cache.invalidateQueries({ queryKey: ["locations"] });
                } else {
                  sessionStorage.setItem(draftKey, JSON.stringify(form));
                  setGuest(form);
                }
                setDeliveryPin({ latitude: form.latitude, longitude: form.longitude });
                window.dispatchEvent(new Event("commerce-location"));
                await cache.invalidateQueries({
                  predicate: (q) => shouldRefreshForDelivery(q.queryKey),
                });
                complete(savedLocationId);
              });
            }}
          >
            <DeliveryFields value={form} onChange={setForm} showDefault={!!customer} onBrowseLocation={!customer && !onComplete ? location => {
              void a.run(async () => {
                // A neighborhood is enough for catalog availability, but is not
                // a street address that can later be saved for order delivery.
                const area = { ...emptyDelivery, location_method: "neighborhood" as const, geography: location.geography, latitude: location.latitude, longitude: location.longitude };
                sessionStorage.setItem(draftKey, JSON.stringify(area));
                setGuest(area);
                setDeliveryPin({ latitude: area.latitude, longitude: area.longitude });
                window.dispatchEvent(new Event("commerce-location"));
                await cache.invalidateQueries({ predicate: query => shouldRefreshForDelivery(query.queryKey) });
                complete();
              });
            } : undefined} />
            <div className="delivery-form-actions">
            {!customer && (
              <p className="help">
                {ui("storefront.your_address_is_kept_for_this_visit_sign_in_to_save_it_to_your_account_and_place_an_order", "Your address is kept for this visit. Sign in to save it to your account and place an order.")} </p>
            )}
            <button disabled={a.busy}>
              {a.busy ? ui("storefront.saving_your_address", "Saving your address…") : customer ? ui("storefront.save_delivery_address", "Save delivery address") : ui("storefront.use_this_delivery_address", "Use this delivery address")}
            </button>{" "}
            {onCancel ? <button type="button" className="text-button" onClick={onCancel}>{ui("storefront.not_now", "Not now")}</button> : <Link className="delivery-cancel" to={returnTo}>{ui("cart.continue_shopping", "Continue shopping")}</Link>}
            </div>
          </form>}
        </section>
        {!onComplete && <aside className="delivery-help-panel">
          <div className="delivery-summary-title"><DeliveryIcon /><h2>{ui("storefront.your_delivery_location", "Your delivery location")}</h2></div>
          <p className="delivery-summary-address">{form.formatted_address || ui("storefront.add_your_street_address", "Add your street address")}</p>
          {form.geography?.city_id && <p className="delivery-summary-detail">{geographyLabel(form)}</p>}
          <p className="delivery-summary-detail">{[form.building && ui("address.building_value", "Building {value}", {value:form.building}), form.floor && ui("address.floor_value", "Floor {value}", {value:form.floor}), form.apartment && ui("address.apartment_value", "Apartment {value}", {value:form.apartment})].filter(Boolean).join(" · ") || ui("storefront.your_building_details_will_appear_here", "Your building details will appear here.")}</p>
          <div className="delivery-coverage" data-state={pinValid && coverage.data?.deliverable ? "available" : "pending"} role="status">
            <strong>{!pinValid ? ui("storefront.choose_your_delivery_location", "Choose your delivery location") : coverage.isPending ? ui("storefront.checking_this_location", "Checking this location…") : coverage.error ? ui("storefront.availability_could_not_be_checked", "Availability could not be checked") : !coverage.data?.configured ? ui("storefront.delivery_coverage_is_not_set_up_yet", "Delivery coverage is not set up yet") : coverage.data.deliverable ? ui("storefront.this_location_is_inside_a_delivery_area", "This location is inside a delivery area") : ui("storefront.this_location_is_outside_our_delivery_areas", "This location is outside our delivery areas")}</strong>
            <p>{!pinValid ? ui("storefront.choose_your_country_region_and_city_or_pin_your_building_entrance", "Choose your country, region and city, or pin your building entrance.") : coverage.error ? ui("storefront.you_can_save_your_address_and_check_availability_again_later", "You can save your address and check availability again later.") : coverage.data?.configured && !coverage.data.deliverable ? ui("storefront.you_can_save_this_address_but_ordering_here_is_not_currently_available_check_your_selected_city_or_p", "You can save this address, but ordering here is not currently available. Check your selected city or pin.") : ui("storefront.saving_this_address_updates_the_products_you_can_shop_neighborhood_availability_is_based_on_an_appro", "Saving this address updates the products you can shop. Neighborhood availability is based on an approximate area location.")}</p>
          </div>
          <h3>{ui("storefront.two_ways_to_choose", "Two ways to choose")}</h3>
          <p><strong>{ui("storefront.choose_your_neighborhood", "Choose your neighborhood")}</strong>  {ui("storefront.to_select_a_country_region_and_city_without_using_the_map", "to select a country, region and city without using the map.")}</p>
          <p><strong>{ui("storefront.or_pin_your_entrance", "Or pin your entrance")}</strong>  {ui("storefront.to_give_the_driver_an_exact_map_location", "to give the driver an exact map location.")}</p>
          <p><strong>{ui("storefront.your_address_details", "Your address details")}</strong>  {ui("storefront.tell_the_driver_the_building_floor_and_apartment", "tell the driver the building, floor, and apartment.")}</p>
          {(selected || guest) && <div className="delivery-current"><small>{ui("storefront.currently_used_for_shopping", "Currently used for shopping")}</small><p>{selected?.formatted_address || guest?.formatted_address}</p></div>}
          <Link className="delivery-support" to="/support">{ui("storefront.need_help_with_your_address", "Need help with your address?")}</Link>
        </aside>}
      </div>
    </div>
  );
}


export function useDeliveryStatus(){const key=useDeliveryKey();return useQuery({queryKey:["delivery-area",key],queryFn:deliveryApi.resolve,refetchInterval:5000});}
