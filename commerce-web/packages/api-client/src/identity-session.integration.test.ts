import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Exercise the real generated client and traceFetch over loopback HTTP. Only the
// remote identity service is a fixture so its response order is deterministic.
const NativeRequest = Request;
const customer = { id: 'customer-a' };
const otherCustomer = { id: 'customer-b' };
let server: ReturnType<typeof createServer>;
let handle: (request: IncomingMessage, response: ServerResponse) => void;
function respond(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(async () => {
  vi.resetModules();
  handle = (_request, response) => respond(response, { error: 'Unexpected request' }, 500);
  server = createServer((request, response) => handle(request, response));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal('Request', class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === 'string' ? new URL(input, base) : input, init);
    }
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

it.each(['logout', 'reset'] as const)('a delayed refresh cannot restore credentials after %s', async action => {
  const refresh = deferred<ServerResponse>();
  handle = (request, response) => {
    if (request.url?.endsWith('/refresh')) refresh.resolve(response);
    else respond(response, { status: 'ok' });
  };
  const { customerApi, customerSessionHeaders } = await import('./identity');
  const restoring = customerApi.restore().then(value => ({ value }), error => ({ error }));
  const pendingResponse = await refresh.promise;
  if (action === 'logout') await customerApi.logout();
  else await customerApi.reset('shopper@example.test', 'reset-token', 'new-password');
  respond(pendingResponse, { customer, access_token: 'revoked-access' });
  expect(await restoring).toMatchObject({ error: { status: 401 } });
  expect(customerSessionHeaders()).not.toHaveProperty('Authorization');
});

it('a delayed earlier refresh cannot overwrite a newly logged-in customer', async () => {
  const refresh = deferred<ServerResponse>();
  handle = (request, response) => {
    if (request.url?.endsWith('/refresh')) refresh.resolve(response);
    else respond(response, { customer: otherCustomer, access_token: 'customer-b-access' });
  };
  const { customerApi, customerSessionHeaders } = await import('./identity');
  const restoring = customerApi.restore().then(value => ({ value }), error => ({ error }));
  const pendingResponse = await refresh.promise;
  await customerApi.login('customer-b@example.test', 'password');
  respond(pendingResponse, { customer, access_token: 'customer-a-access' });
  expect(await restoring).toMatchObject({ error: { status: 401 } });
  expect(customerSessionHeaders()).toHaveProperty('Authorization', 'Bearer customer-b-access');
});

it.each([401, 403])('a rejected refresh (%s) removes the rejected bearer token', async status => {
  handle = (request, response) => request.url?.endsWith('/login')
    ? respond(response, { customer, access_token: 'rejected-access' })
    : respond(response, { error: 'Session revoked' }, status);
  const { customerApi, customerSessionHeaders } = await import('./identity');
  await customerApi.login('customer@example.test', 'password');
  await expect(customerApi.restore()).rejects.toMatchObject({ status });
  expect(customerSessionHeaders()).not.toHaveProperty('Authorization');
});

it('a temporary refresh outage preserves the active token for recovery', async () => {
  handle = (request, response) => request.url?.endsWith('/login')
    ? respond(response, { customer, access_token: 'still-valid' })
    : respond(response, { error: 'Temporary outage' }, 503);
  const { customerApi, customerSessionHeaders } = await import('./identity');
  await customerApi.login('customer@example.test', 'password');
  await expect(customerApi.restore()).rejects.toMatchObject({ status: 503 });
  expect(customerSessionHeaders()).toHaveProperty('Authorization', 'Bearer still-valid');
});


it('a rejected protected request is not replayed under a different login', async () => {
  const pending = deferred<ServerResponse>();
  let loginCount = 0;
  let protectedCalls = 0;
  let refreshCalls = 0;
  handle = (request, response) => {
    if (request.url?.endsWith('/login')) {
      loginCount++;
      respond(response, { customer: loginCount === 1 ? customer : otherCustomer, access_token: `access-${loginCount}` });
    } else if (request.url?.endsWith('/refresh')) {
      refreshCalls++;
      respond(response, { customer: otherCustomer, access_token: 'access-2' });
    } else {
      protectedCalls++;
      if (protectedCalls === 1) pending.resolve(response);
      else respond(response, { status: 'ok' });
    }
  };
  const { customerApi } = await import('./identity');
  await customerApi.login('customer-a@example.test', 'password');
  const deletion = customerApi.deleteLocation('location-a').then(value => ({ value }), error => ({ error }));
  const pendingResponse = await pending.promise;
  await customerApi.login('customer-b@example.test', 'password');
  respond(pendingResponse, { error: 'Earlier session expired' }, 401);
  expect(await deletion).toMatchObject({ error: { status: 401 } });
  expect(protectedCalls).toBe(1);
  expect(refreshCalls).toBe(0);
});

it('finishing an obsolete refresh does not detach a newer shared refresh', async () => {
  const oldRequest = deferred<ServerResponse>();
  const newRequest = deferred<ServerResponse>();
  let refreshCalls = 0;
  handle = (request, response) => {
    if (request.url?.endsWith('/refresh')) {
      refreshCalls++;
      if (refreshCalls === 1) oldRequest.resolve(response);
      else if (refreshCalls === 2) newRequest.resolve(response);
      else respond(response, { error: 'Unexpected duplicate refresh' }, 500);
    } else respond(response, { customer: otherCustomer, access_token: 'access-2' });
  };
  const { customerApi, customerSessionHeaders } = await import('./identity');
  const oldRestore = customerApi.restore().catch(error => error);
  const oldResponse = await oldRequest.promise;
  await customerApi.login('customer-b@example.test', 'password');
  const newRestore = customerApi.restore();
  const newResponse = await newRequest.promise;
  respond(oldResponse, { customer, access_token: 'access-1' });
  await expect(oldRestore).resolves.toMatchObject({ status: 401 });
  const anotherRestore = customerApi.restore();
  respond(newResponse, { customer: otherCustomer, access_token: 'current-access' });
  await expect(Promise.all([newRestore, anotherRestore])).resolves.toEqual([otherCustomer, otherCustomer]);
  expect(refreshCalls).toBe(2);
  expect(customerSessionHeaders()).toHaveProperty('Authorization', 'Bearer current-access');
});


it('a successful protected response from the old customer is discarded after login changes', async () => {
  const pending = deferred<ServerResponse>();
  handle = (request, response) => request.url?.endsWith('/me')
    ? pending.resolve(response)
    : respond(response, { customer: otherCustomer, access_token: 'access-2' });
  const { customerApi } = await import('./identity');
  const earlierProfile = customerApi.me().then(value => ({ value }), error => ({ error }));
  const pendingResponse = await pending.promise;
  await customerApi.login('customer-b@example.test', 'password');
  respond(pendingResponse, customer);
  expect(await earlierProfile).toMatchObject({ error: { status: 401 } });
});

it('cart initialization cannot continue a queued add under the next customer', async () => {
  const pending = deferred<ServerResponse>();
  let adds = 0;
  handle = (request, response) => {
    if (request.url === '/api/v1/cart') pending.resolve(response);
    else if (request.url?.endsWith('/items')) { adds++; respond(response, { items: [] }); }
    else respond(response, { customer: otherCustomer, access_token: 'access-2' });
  };
  const { customerApi, cartApi } = await import('./identity');
  const earlierAdd = cartApi.add('product-a', 1).then(value => ({ value }), error => ({ error }));
  const pendingResponse = await pending.promise;
  await customerApi.login('customer-b@example.test', 'password');
  respond(pendingResponse, { id: 'cart-a', items: [] });
  expect(await earlierAdd).toMatchObject({ error: { status: 401 } });
  expect(adds).toBe(0);
});

it('a newly signed-in customer opens a separate cart from an earlier pending session', async () => {
  const pending = deferred<ServerResponse>();
  let opens = 0;
  handle = (request, response) => {
    if (request.url === '/api/v1/cart') {
      opens++;
      if (opens === 1) pending.resolve(response);
      else respond(response, { id: 'cart-b', items: [] });
    } else respond(response, { customer: otherCustomer, access_token: 'access-2' });
  };
  const { customerApi, cartApi } = await import('./identity');
  const earlierCart = cartApi.open().catch(error => error);
  const pendingResponse = await pending.promise;
  await customerApi.login('customer-b@example.test', 'password');
  const nextCart = cartApi.open();
  respond(pendingResponse, { id: 'cart-a', items: [] });
  await expect(nextCart).resolves.toMatchObject({ id: 'cart-b' });
  await expect(earlierCart).resolves.toMatchObject({ status: 401 });
  expect(opens).toBe(2);
});


it.each(['login', 'logout'] as const)('a protected retry response cannot outlive a later %s', async action => {
  const pending = deferred<ServerResponse>();
  let attempts = 0;
  handle = (request, response) => {
    if (request.url?.endsWith('/me')) {
      attempts++;
      if (attempts === 1) respond(response, { error: 'Expired' }, 401);
      else pending.resolve(response);
    } else if (request.url?.endsWith('/refresh')) respond(response, { customer, access_token: 'refreshed-a' });
    else respond(response, { customer: otherCustomer, access_token: 'access-b' });
  };
  const { customerApi } = await import('./identity');
  const profile = customerApi.me().then(value => ({ value }), error => ({ error }));
  const retryResponse = await pending.promise;
  if (action === 'login') await customerApi.login('customer-b@example.test', 'password');
  else await customerApi.logout();
  respond(retryResponse, customer);
  expect(await profile).toMatchObject({ error: { status: 401 } });
  expect(attempts).toBe(2);
});

it.each([204, 401, 403])('definitive refresh rejection %s invalidates already-pending private responses', async status => {
  const pending = deferred<ServerResponse>();
  handle = (request, response) => {
    if (request.url?.endsWith('/me')) pending.resolve(response);
    else if (request.url?.endsWith('/refresh')) {
      if (status === 204) { response.writeHead(status); response.end(); }
      else respond(response, { error: 'Session revoked' }, status);
    } else respond(response, { customer, access_token: 'old-access' });
  };
  const { customerApi } = await import('./identity');
  await customerApi.login('customer-a@example.test', 'password');
  const profile = customerApi.me().then(value => ({ value }), error => ({ error }));
  const oldResponse = await pending.promise;
  await expect(customerApi.restore()).rejects.toMatchObject({ status: status === 204 ? 401 : status });
  respond(oldResponse, customer);
  expect(await profile).toMatchObject({ error: { status: 401 } });
});
