import { useSyncExternalStore } from 'react';
import { deliveryKey } from '@commerce/api-client';

const subscribe = (callback: () => void) => {
  window.addEventListener('commerce-delivery', callback);
  return () => window.removeEventListener('commerce-delivery', callback);
};

// Search only needs the delivery identity, not the address editor or its CSS.
export function useDeliveryKey() {
  return useSyncExternalStore(subscribe, deliveryKey, () => 'none');
}
