import { useInterface } from '../interface-locale';
import { useRef, useState, type ComponentType } from 'react';
import type { SearchInitialState } from '../search';
import '../search.css';

export function PublicSearch() {
  const {t: ui}=useInterface();
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const [enhancement, setEnhancement] = useState<{
    Widget: ComponentType<{ initialState?: SearchInitialState }>;
    initialState: SearchInitialState;
  } | null>(null);

  const enhance = () => {
    if (pending.current || enhancement) return;
    pending.current = true;
    void import('./search-widget').then(({ default: Widget }) => {
      const field = input.current;
      if (!field) return;
      // Read at completion so typing during the download is never lost. Do not
      // steal focus when a shopper has already moved to another control.
      setEnhancement({ Widget, initialState: {
        value: field.value, focused: document.activeElement === field,
        selectionStart: field.selectionStart, selectionEnd: field.selectionEnd,
      } });
    }).catch(() => { pending.current = false; });
  };

  if (enhancement) return <enhancement.Widget initialState={enhancement.initialState} />;
  return <div className="store-search" onFocus={enhance}>
    <form className="search-bar" action="/search" role="search">
      <span aria-hidden="true">⌕</span>
      <input ref={input} name="q" role="combobox" aria-label={ui("search.label", "Search products")}
        aria-autocomplete="list" aria-expanded={false} autoComplete="off"
        maxLength={200} placeholder={ui("search.placeholder", "Search products, brands and essentials")} />
      <button type="submit" className="search-submit" aria-label={ui("storefront.search", "Search")}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>
      </button>
    </form>
  </div>;
}
