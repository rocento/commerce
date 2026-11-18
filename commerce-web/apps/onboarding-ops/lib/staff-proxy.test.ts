import { expect, test, vi, afterEach } from 'vitest';
import { staffProxy } from './staff-proxy';
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
function env(){vi.stubEnv('NODE_ENV','production');vi.stubEnv('STAFF_ORIGIN','https://ops.rocento.com');vi.stubEnv('CONTROL_API_URL','http://127.0.0.1:4100');}
test('staff session stays in a secure host-only cookie and server token is removed',async()=>{
 env();vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({sessionToken:'a'.repeat(64),user:{role:'OWNER'}})));
 const r=await staffProxy(new Request('https://ops.rocento.com/api/control/auth/login',{method:'POST',headers:{origin:'https://ops.rocento.com','x-rocento-request':'1','content-type':'application/json'},body:'{}'}),['auth','login']);
 expect(r.headers.get('set-cookie')).toContain('__Host-rocento_staff=');expect(r.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');expect(r.headers.get('set-cookie')).toContain('Secure');expect(await r.json()).not.toHaveProperty('sessionToken');
});
test('customer cookies and arbitrary operator paths cannot reach staff operations',async()=>{
 env();const fetch=vi.fn().mockResolvedValue(Response.json({code:'STAFF_SESSION_REQUIRED'},{status:401}));vi.stubGlobal('fetch',fetch);
 await staffProxy(new Request('https://ops.rocento.com/api/control/dashboard',{headers:{cookie:'__Host-rocento_customer='+'b'.repeat(64)}}),['dashboard']);
 expect(fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
 const r=await staffProxy(new Request('https://ops.rocento.com/api/control/operator/billing'),['operator','billing']);expect(r.status).toBe(404);expect(fetch).toHaveBeenCalledTimes(1);
});
test('cross-origin state changes are rejected before forwarding',async()=>{
 env();const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 const r=await staffProxy(new Request('https://ops.rocento.com/api/control/auth/logout',{method:'POST',headers:{origin:'https://onboarding.rocento.com','x-rocento-request':'1','content-type':'application/json'},body:'{}'}),['auth','logout']);expect(r.status).toBe(403);expect(fetch).not.toHaveBeenCalled();
});

test('provider selection forwards only through the staff session and origin check',async()=>{
 env();const fetch=vi.fn().mockResolvedValue(Response.json({provider:'hetzner'}));vi.stubGlobal('fetch',fetch);
 const id='11111111-1111-4111-8111-111111111111';
 const r=await staffProxy(new Request(`https://ops.rocento.com/api/control/stores/${id}/hosting`,{method:'POST',headers:{origin:'https://ops.rocento.com','x-rocento-request':'1','content-type':'application/json',cookie:'__Host-rocento_staff='+'a'.repeat(64)},body:JSON.stringify({provider:'hetzner'})}),['stores',id,'hosting']);
 expect(r.status).toBe(200);expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer '+'a'.repeat(64));
 expect(fetch.mock.calls[0][0]).toContain(`/staff/stores/${id}/hosting`);
});
