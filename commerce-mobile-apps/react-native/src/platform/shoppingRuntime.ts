import type { CommerceClient } from '../core/commerce';
import { ShoppingRuntime } from '../core/shoppingRuntime';
import { settingsPreferences } from './settingsPreferences';
import { notificationPreferences } from './notificationPreferences';

/** Platform composition entry point for both live and fixture storefronts. */
export function createShoppingRuntime(client: CommerceClient) {
  return new ShoppingRuntime(client, settingsPreferences, notificationPreferences);
}
