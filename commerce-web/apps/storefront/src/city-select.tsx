import { useInterface } from './interface-locale';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { findDeliveryCities, type DeliveryCity } from './delivery-geography';

export function CitySelect({ cities, selectedId, selectedName, disabled, placeholder, onSelect }: {
  cities: DeliveryCity[]; selectedId?: string; selectedName?: string; disabled: boolean; placeholder: string; onSelect: (city?: DeliveryCity) => void;
}) {
  const { t: ui } = useInterface();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(-1);
  const { options, hasMore } = useMemo(() => findDeliveryCities(cities, search), [cities, search]);
  useEffect(() => { input.current?.setCustomValidity(selectedId ? '' : ui('address.select_city', 'Choose a city or neighborhood from the list.')); }, [selectedId, ui]);
  useEffect(() => {
    if (open && active >= 0) document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open, id]);
  function choose(city: DeliveryCity) {
    onSelect(city);
    setSearch('');
    setOpen(false);
    setActive(-1);
  }
  return <div className="city-select field">
    <label htmlFor={id}>{ui("address.city_label", "City / Town / Neighborhood")}</label>
    <div className="city-select-input">
      <input ref={input} id={id} role="combobox" aria-autocomplete="list" aria-expanded={open && !disabled} aria-controls={`${id}-list`} aria-activedescendant={open && active >= 0 && active < options.length ? `${id}-option-${active}` : undefined}
        autoComplete="off" required disabled={disabled} placeholder={placeholder} value={selectedId ? selectedName || '' : search}
        onFocus={() => { setOpen(true); setActive(-1); }}
        onClick={() => setOpen(true)}
        onBlur={() => { setOpen(false); setActive(-1); }}
        onChange={event => { setSearch(event.target.value); setOpen(true); setActive(-1); onSelect(undefined); }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); setOpen(true);
            setActive(value => options.length ? (event.key === 'ArrowDown' ? Math.min(value + 1, options.length - 1) : value < 0 ? options.length - 1 : Math.max(0, value - 1)) : -1);
          } else if (event.key === 'Enter' && open) {
            event.preventDefault();
            if (active >= 0 && options[active]) choose(options[active]);
          } else if (event.key === 'Escape') { event.preventDefault(); setOpen(false); setActive(-1); }
        }} />
      <span className="city-select-chevron" aria-hidden="true" />
    </div>
    {open && !disabled && <div className="city-select-dropdown">
      <ul id={`${id}-list`} role="listbox" aria-label={ui("address.city_options", "Cities and neighborhoods")}>
        {options.map((city, index) => <li key={city.id} id={`${id}-option-${index}`} role="option" aria-selected={city.id === selectedId} data-active={active === index}
          onMouseDown={event => event.preventDefault()} onClick={() => choose(city)}>{city.name}{city.district && <small className="city-select-district">{city.district}</small>}</li>)}
      </ul>
      {hasMore && <p role="status">{ui("address.more_cities", "Showing the first 60 matches. Type more of the place name to narrow the list.")}</p>}
      {!options.length && <p role="status">{ui("address.no_cities", "No matching locations")}</p>}
    </div>}
  </div>;
}
