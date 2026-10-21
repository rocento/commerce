import { useEffect, useState } from 'react';
import type { MobileCatalogProduct } from '@commerce/api-client';
export type CartLine = { product: MobileCatalogProduct; quantity: number };
export function lineTotal(line: CartLine) {
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency: line.product.currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const scale = 10 ** digits;
  return Math.round(Number(line.product.price) * scale) * line.quantity / scale;
}
export function usePreviewCart(merchant: string) {
  const [state, setState] = useState<{ merchant: string; lines: CartLine[] }>({ merchant, lines: [] });
  useEffect(() => setState(current => current.merchant === merchant ? current : { merchant, lines: [] }), [merchant]);
  const lines = state.merchant === merchant ? state.lines : [];
  const change = (update: (lines: CartLine[]) => CartLine[]) => setState(current => ({ merchant, lines: update(current.merchant === merchant ? current.lines : []) }));
  const canAdd = (product: MobileCatalogProduct) => product.productType !== 'configurable' && product.inStock && Number.isFinite(Number(product.price)) && Number(product.price) >= 0 && (!lines.length || lines[0].product.currency === product.currency) && (lines.find(l => l.product.id === product.id)?.quantity ?? 0) < 99;
  return {
    lines, canAdd,
    addLines: (incoming: CartLine[]) => change(current => {
      let next = [...current];
      for (const {product,quantity} of incoming) {
        if (product.productType === 'configurable' || !product.inStock || !Number.isFinite(Number(product.price)) || Number(product.price)<0 || !Number.isInteger(quantity) || quantity<1 || (next.length && next[0].product.currency!==product.currency)) continue;
        const existing=next.find(line=>line.product.id===product.id);
        next=existing ? next.map(line=>line.product.id===product.id ? {product,quantity:Math.min(99,line.quantity+quantity)} : line) : [...next,{product,quantity:Math.min(99,quantity)}];
      }
      return next;
    }),
    count: lines.reduce((sum, line) => sum + line.quantity, 0),
    add: (product: MobileCatalogProduct, quantity = 1) => change(current => {
      if (product.productType === 'configurable' || !Number.isInteger(quantity) || quantity < 1 || quantity > 99 || !product.inStock || !Number.isFinite(Number(product.price)) || Number(product.price) < 0 || (current.length && current[0].product.currency !== product.currency)) return current;
      const existing = current.find(line => line.product.id === product.id);
      return existing ? current.map(line => line.product.id === product.id ? { product, quantity: Math.min(99, line.quantity + quantity) } : line) : [...current, { product, quantity }];
    }),
    quantity: (id: string, amount: number) => change(current => current.map(line => line.product.id === id ? { ...line, quantity: Math.max(1, Math.min(99, amount)) } : line)),
    remove: (id: string) => change(current => current.filter(line => line.product.id !== id)),
    clear: () => change(() => []),
  };
}
