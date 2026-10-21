import { customerApi, deliveryKey, setDeliveryPin, type DeliveryPin } from '@commerce/api-client';
import { selectDeliveryLocation } from '../locations-logic';

/** Restore an explicitly saved location only when public best sellers need it. */
export async function restoreBestsellerLocation() {
  if (deliveryKey() !== 'none') return;
  let guest: DeliveryPin | null = null;
  let hasSavedCustomerLocation = false;
  try {
    const saved = JSON.parse(sessionStorage.getItem('commerce-guest-location') || 'null');
    if (saved && Number.isFinite(saved.latitude) && Number.isFinite(saved.longitude)) guest = saved;
    hasSavedCustomerLocation = Object.keys(sessionStorage).some(key => key.startsWith('commerce-active-location:') && key !== 'commerce-active-location:guest' && sessionStorage.getItem(key));
  } catch { /* Storage may be unavailable; retain global ranking. */ }
  if (hasSavedCustomerLocation) {
    try {
      const customer = await customerApi.restore();
      const locations = await customerApi.locations();
      const selected = selectDeliveryLocation(locations, sessionStorage.getItem(`commerce-active-location:${customer.id}`) || '');
      if (selected) { if (deliveryKey() === 'none') setDeliveryPin(selected); return; }
    } catch { /* An expired customer session can still use a saved guest pin. */ }
  }
  if (deliveryKey() === 'none') setDeliveryPin(guest);
}
