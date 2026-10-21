import { useInterface } from './interface-locale';
import { useState, type CSSProperties } from 'react';

/** The upper slider endpoint removes the ceiling; typed prices can extend the scale. */
export function PriceFilter({ min, max }: { min?: string; max?: string }) {
  const { t: ui } = useInterface();
  const [low, setLow] = useState(Number(min) || 0);
  const [high, setHigh] = useState<number | ''>(max ? Number(max) : '');
  const ceiling = Math.max(1000, Math.ceil(low / 500) * 500, Math.ceil(Number(high) / 500) * 500);
  const upper = high === '' ? ceiling : high;
  return <fieldset className="price-filter">
    <legend>{ui("storefront.price", "Price")}</legend>
    <div className="price-range-label"><span>${low.toLocaleString()}</span><span>{high === '' ? ui("storefront.no_limit", "No limit") : `$${high.toLocaleString()}`}</span></div>
    <div className="price-range-track" style={{ '--range-start': `${low / ceiling * 100}%`, '--range-end': `${upper / ceiling * 100}%` } as CSSProperties}>
      <input aria-label={ui("storefront.minimum_price_slider", "Minimum price slider")} aria-valuetext={`$${low}`} type="range" min="0" max={ceiling} step="1" value={low} onChange={e => setLow(Math.min(Number(e.target.value), upper))}/>
      <input aria-label={ui("storefront.maximum_price_slider", "Maximum price slider")} aria-valuetext={high === '' ? ui("search.no_price_limit", "No price limit") : `$${high}`} type="range" min="0" max={ceiling} step="1" value={upper} onChange={e => { const value = Math.max(Number(e.target.value), low); setHigh(value === ceiling ? '' : value); }}/>
    </div>
    <div className="price-fields">
      <label>{ui("storefront.from", "From ($)")}<input aria-label={ui("storefront.minimum_price", "Minimum price")} name="min" type="number" min="0" max={high === '' ? undefined : high} step="0.01" value={low || ''} placeholder="0" onChange={e => setLow(Math.max(0, high === '' ? Number(e.target.value) : Math.min(Number(e.target.value), high)))}/></label>
      <label>{ui("storefront.to", "To ($)")}<input aria-label={ui("storefront.maximum_price", "Maximum price")} name="max" type="number" min={low} step="0.01" value={high} placeholder={ui("storefront.no_limit", "No limit")} onChange={e => setHigh(e.target.value === '' ? '' : Math.max(low, Number(e.target.value)))}/></label>
    </div>
  </fieldset>;
}
