import { fetch } from 'expo/fetch';
import * as SecureStore from 'expo-secure-store';
import { randomUUID } from 'expo-crypto';
import { CommerceClient, merchant, type StorefrontConfiguration } from '../core/commerce';

const options = { keychainService: 'com.rocento.reactnative.commerce.v1', keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
export const commerce = new CommerceClient(fetch, {
  get: key => SecureStore.getItemAsync(key, options),
  set: (key, value) => value === null ? SecureStore.deleteItemAsync(key, options) : SecureStore.setItemAsync(key, value, options),
}, randomUUID);

export const liveConfiguration: StorefrontConfiguration = { identity: merchant, commerce };
