import * as SecureStore from 'expo-secure-store';
import { merchant, type Storage } from '../core/commerce';
const options = { keychainService: 'com.rocento.reactnative.settings.v1', keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const key = (value: string) => `rocento.rn.settings.${merchant.id}.${value}`;
export const settingsPreferences: Storage = {
  get: value => SecureStore.getItemAsync(key(value), options),
  set: (value, data) => data === null ? SecureStore.deleteItemAsync(key(value), options) : SecureStore.setItemAsync(key(value), data, options),
};
