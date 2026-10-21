// Development-only native acceptance. No network fallback and no production keys.
import { useEffect, useState } from 'react';
import { ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import { randomUUID } from 'expo-crypto';
import { CommerceClient, type Transport } from '../core/commerce';
import { Copy } from '../ui/Storefront';
import fixture from './commerce-flow.json';

const options = { keychainService: 'com.rocento.reactnative.acceptance.v1', keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const storage = {
  get: (key: string) => SecureStore.getItemAsync(`acceptance.${key}`, options),
  set: (key: string, value: string | null) => value === null ? SecureStore.deleteItemAsync(`acceptance.${key}`, options) : SecureStore.setItemAsync(`acceptance.${key}`, value, options),
};
const response = (data: unknown, auth = false) => new Response(JSON.stringify(data), { status: 200, headers: auth ? { 'set-cookie': `customer_refresh=${'f'.repeat(64)}; HttpOnly; Secure` } : {} });
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };

export default function Acceptance() {
  const [status, setStatus] = useState('Checking native commerce storage…');
  useEffect(() => {
    let lastRoute = 'storage';
    void (async () => {
      let interrupt = false;
      const transport: Transport = async (url, init) => {
        const path = new URL(url).pathname.replace('/api/', '');
        lastRoute = path;
        if (path === 'v1/customer/auth/login') return response(fixture.auth, true);
        if (path === 'v1/customer/auth/refresh') {
          assert(new Headers(init.headers).get('cookie') === `customer_refresh=${'f'.repeat(64)}`, 'Refresh cookie did not survive');
          return response(fixture.auth, true);
        }
        if (path === 'v1/customer/auth/logout') return response({});
        if (path === 'v1/catalog/categories') return response(fixture.categories);
        if (path === 'v1/search') return response({ hits: [fixture.product], total: 1 });
        if (path.endsWith('/family')) return response(fixture.family);
        if (path === `v1/catalog/products/${fixture.variant.id}`) return response(fixture.variant);
        if (path === 'v1/cart' || path === 'v1/cart/items') return response(fixture.cart);
        if (path === 'v1/customer/locations') return response(fixture.locations);
        if (path === 'v1/fulfillment/availability') return response(fixture.availability);
        if (path === 'v1/fulfillment/plan-options') return response(fixture.options);
        if (path === 'v1/fulfillment/plans') return response(fixture.plan);
        if (path === 'v1/customer/checkout/quote') return response(fixture.quote);
        if (path === 'v1/customer/checkout/place') {
          const pending = await client.pending();
          const body = JSON.parse(init.body as string);
          assert(pending?.key === body.idempotency_key, 'Order key was not saved before send');
          if (interrupt) throw new Error('Simulated transport interruption');
          return response(fixture.detail);
        }
        if (path === 'v1/customer/orders') return response([fixture.order]);
        if (path === `v1/customer/orders/${fixture.order.id}`) return response(fixture.detail);
        throw new Error(`No fixture route: ${path}`);
      };
      const client = new CommerceClient(transport, storage, randomUUID);
      const stage = await storage.get('stage.v1');
      if (stage === 'pending') {
        assert((await client.restore())?.id === fixture.customer.id, 'Session did not survive process restart');
        const attempt = await client.pending();
        assert(attempt?.quote.id === fixture.quote.id, 'Pending order did not survive process restart');
        assert((await client.place(attempt!.quote)).order.id === fixture.order.id, 'Order recovery failed');
        assert(await client.pending() === null, 'Recovered order was not cleared');
        await client.logout();
        assert(await new CommerceClient(transport, storage, randomUUID).restore() === null, 'Logout failed to clear refresh credential');
        await storage.set('stage.v1', null);
        setStatus('PASS — native commerce acceptance\n\nSecure login and refresh\nSession restored after process restart\nPending checkout restored after process restart\nSame order key recovered\nConfirmed checkout cleared\nLogout removed session\n\nAll requests used isolated fixtures. No production account or order was created.');
        return;
      }
      await client.login('native-fixture@example.test', 'fixture-only');
      assert((await client.categories()).length > 0, 'Categories failed');
      assert((await client.search()).hits.length > 0, 'Search failed');
      assert((await client.family(fixture.product.id)).children.length > 0, 'Variants failed');
      client.pin = fixture.location;
      assert((await client.add(fixture.variant)).items.length === 1, 'Cart failed');
      const request = { method: 'delivery', location_id: fixture.location.id, source_id: null, date: '2026-10-12', asap: true };
      await client.options(request);
      const quote = await client.quote(request, []);
      interrupt = true;
      try { await client.place(quote); throw new Error('Expected interruption'); }
      catch { assert((await client.pending())?.quote.id === quote.id, 'Uncertain checkout was not retained'); }
      await storage.set('stage.v1', 'pending');
      setStatus('PASS — stage 1\n\nNative Keychain/Keystore credential saved\nCatalog, variants and cart passed\nFulfillment and quote passed\nInterrupted checkout retained safely\n\nRestart this app to verify persisted recovery.');
    })().catch(error => setStatus(`FAIL (${lastRoute}) — ${error instanceof Error ? error.message : 'Native acceptance failed'}`));
  }, []);
  return <SafeAreaView style={{ flex: 1, backgroundColor: '#FCFAF6' }}><ScrollView contentContainerStyle={{ padding: 26 }}><Copy style={{ fontSize: 22, lineHeight: 34 }}>{status}</Copy></ScrollView></SafeAreaView>;
}
