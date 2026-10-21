import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { inventoryApi } from '@commerce/api-client';
import { useCart } from './cart';
import { useDeliveryKey, useDeliveryStatus } from './locations';
import { useAssistantDelivery } from './assistant-delivery-context';

/** Card actions use the shared cart queue, without creating a chat turn. */
export function AssistantAddToCart({ id, name, quantity, disabled = false, onAdding }: {
  id: string; name: string; quantity: number; disabled?: boolean; onAdding?: () => void;
}) {
  const delivery = useDeliveryKey();
  const status = useDeliveryStatus();
  const assistantDelivery = useAssistantDelivery();
  const { cart, ready, error, quantities, quantityErrors, changeQuantity } = useCart();
  const [clicked, setClicked] = useState(false);
  const stock = useQuery({ queryKey: ['stock', id, delivery], queryFn: () => inventoryApi.stock(id), refetchInterval: 3000 });
  const item = cart?.items.find(item => item.product_id === id);
  const pending = quantities[id];
  const count = pending?.quantity ?? item?.quantity ?? 0;
  const limit = pending?.limit ?? Math.min((stock.data?.available ?? 0) + (item?.reserved_quantity ?? 0), item?.available ?? Infinity);
  const valid = Number.isInteger(quantity) && quantity > 0 && quantity <= 1000000;
  const failure = quantityErrors[id] || stock.error?.message || error?.message;
  if (assistantDelivery && delivery === 'none' && status.data?.configured) return <button type="button" disabled={disabled} onClick={assistantDelivery.requestLocation}>Choose delivery address</button>;
  return <div className="assistant-inline-cart-action">
    <button type="button" disabled={disabled || !ready || !!error || !!stock.error || stock.isPending || !!pending || !valid || count + quantity > limit}
      onClick={() => { onAdding?.(); setClicked(true); changeQuantity(id, quantity, limit); }}>
      {pending ? 'Adding…' : `Add ${quantity} to cart`}
    </button>
    {failure ? <p role="alert">{failure}</p> : clicked && <p role="status">{pending ? 'Updating cart…' : `${count} × ${name} in cart`}</p>}
  </div>;
}
