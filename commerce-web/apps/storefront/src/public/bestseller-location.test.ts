import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { restoreBestsellerLocation } from './bestseller-location';
import { customerApi, deliveryKey, setDeliveryPin } from '@commerce/api-client';

vi.mock('@commerce/api-client', () => ({
  customerApi: { restore: vi.fn(), locations: vi.fn() },
  deliveryKey: vi.fn(() => 'none'), setDeliveryPin: vi.fn(),
}));
function storage(values: Record<string, string>) {
  vi.stubGlobal('sessionStorage', { ...values, getItem: (key: string) => values[key] ?? null });
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(deliveryKey).mockReturnValue('none'); });
afterEach(() => { vi.unstubAllGlobals(); });
it('restores the guest pin without requesting a customer session', async () => {
  storage({ 'commerce-guest-location': JSON.stringify({ latitude:30, longitude:31 }) });
  await restoreBestsellerLocation();
  expect(setDeliveryPin).toHaveBeenCalledWith({ latitude:30, longitude:31 });
  expect(customerApi.restore).not.toHaveBeenCalled();
});
it('restores the signed-in customer selection ahead of the guest pin', async () => {
  storage({ 'commerce-active-location:owner':'selected', 'commerce-guest-location':JSON.stringify({latitude:30,longitude:31}) });
  vi.mocked(customerApi.restore).mockResolvedValue({ id:'owner' } as never);
  vi.mocked(customerApi.locations).mockResolvedValue([
    {id:'default',latitude:30,longitude:31,is_default:true},
    {id:'selected',latitude:32,longitude:33,is_default:false},
  ] as never);
  await restoreBestsellerLocation();
  expect(setDeliveryPin).toHaveBeenCalledWith(expect.objectContaining({latitude:32,longitude:33}));
});
it('falls back to a guest pin when the saved customer session has expired', async () => {
  storage({ 'commerce-active-location:owner':'selected', 'commerce-guest-location':JSON.stringify({latitude:30,longitude:31}) });
  vi.mocked(customerApi.restore).mockRejectedValue(new Error('Expired'));
  await restoreBestsellerLocation();
  expect(setDeliveryPin).toHaveBeenCalledWith({latitude:30,longitude:31});
});
it('keeps global ranking when there is no saved location', async () => {
  storage({});
  await restoreBestsellerLocation();
  expect(setDeliveryPin).toHaveBeenCalledWith(null);
  expect(customerApi.restore).not.toHaveBeenCalled();
});
it('preserves a location already selected in this page', async () => {
  vi.mocked(deliveryKey).mockReturnValue('30,31');
  await restoreBestsellerLocation();
  expect(setDeliveryPin).not.toHaveBeenCalled();
  expect(customerApi.restore).not.toHaveBeenCalled();
});
