import * as SecureStore from 'expo-secure-store';
import { merchant, type Storage } from '../core/commerce';
const options = { keychainService: 'com.rocento.reactnative.notifications.v1', keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const key = (value: string) => `rocento.rn.notifications.${merchant.id}.${value}`;
export const notificationPreferences: Storage = {
  get: value => SecureStore.getItemAsync(key(value), options),
  set: (value, data) => data === null ? SecureStore.deleteItemAsync(key(value), options) : SecureStore.setItemAsync(key(value), data, options),
};
