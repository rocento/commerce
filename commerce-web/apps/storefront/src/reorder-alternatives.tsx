import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { catalogApi, type Product } from '@commerce/api-client';
export function ReorderAlternatives({ name, excluded, busy, onChoose }: { name: string; excluded: string[]; busy: boolean; onChoose: (p: Product) => void }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState(name);
  const [query, setQuery] = useState('');
  const result = useQuery({ queryKey: ['reorder-alternatives', query], queryFn: () => catalogApi.search({ q: query, in_stock: true }), enabled: open && !!query, retry: false });
  return <div>
    <button type="button" className="secondary" disabled={busy} onClick={() => setOpen(!open)}>{open ? 'Hide alternatives' : 'Choose an alternative'}</button>
    {open && <section aria-label={`Alternatives for ${name}`}>
      <p>Choose a different product explicitly. We do not assume it is equivalent. Review its pack size and quantity; delivery availability is checked when requoted.</p>
      <label>Find an alternative<input value={input} onChange={e => setInput(e.target.value)} /></label>
      <button type="button" disabled={busy || !input.trim()} onClick={() => setQuery(input.trim())}>Search alternatives</button>
      {result.isFetching && <p role="status">Checking products…</p>}
      {result.isError && <p role="alert">Could not load alternatives. Try another search.</p>}
      {result.data && <ul>{result.data.hits.filter(p => !excluded.includes(p.id) && p.product_type === 'simple').slice(0, 5).map(p => <li key={p.id}>
        <strong>{p.name}</strong> · {p.price} {p.currency} / {p.unit}
        <button type="button" disabled={busy} onClick={() => onChoose(p)}>Use {p.name} (1 unit)</button>
      </li>)}</ul>}
      {result.data && !result.data.hits.some(p => !excluded.includes(p.id) && p.product_type === 'simple') && <p>No available alternatives matched. Try another search or remove the unavailable item.</p>}
    </section>}
  </div>;
}
