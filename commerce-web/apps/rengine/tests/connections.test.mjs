import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {createApp} from '../server.mjs';
import {configuration} from '../config.mjs';
import {rememberedSessions, sessionKey} from '../sessions.mjs';
import {connectionVault} from '../connections.mjs';

async function setup(t){
 const dir=mkdtempSync(tmpdir()+'/rengine-vault-');t.after(()=>rmSync(dir,{recursive:true,force:true}));writeFileSync(dir+'/key',randomBytes(32));
 const config=configuration({RENGINE_VAULT_FILE:dir+'/connections',RENGINE_VAULT_KEY_FILE:dir+'/key',RENGINE_OWNER_EMAIL:'owner@test.local'});
 let revoked=false,expired=false,ownerExpired=false,rejectOwner=false,down=false,logins=0;const calls=[];
 const fetcher=async(url,options)=>{
  const u=new URL(url),store=Object.values(config.stores).find(s=>s.gateway===u.origin)?.name;calls.push({store,path:u.pathname,query:u.searchParams});
  if(store==='pharmacy'&&down)return Response.json({}, {status:503});
  if(u.pathname.endsWith('/auth/login')){logins++;const input=JSON.parse(options.body);if(input.password==='wrong'||(rejectOwner&&input.email==='owner@test.local'))return Response.json({}, {status:401});return new Response(JSON.stringify({user:{name:'Operator'},permissions:input.email==='reader@test.local'?['assistant.tracking.read']:['*']}),{headers:{'set-cookie':`admin_session=${input.email==='owner@test.local'?'owner':logins}`}});}
  if(u.pathname==='/v1/admin/me'){if(ownerExpired&&options.headers.cookie==='admin_session=owner'){ownerExpired=false;return Response.json({}, {status:401});}if(expired&&store==='jewelry'&&options.headers.cookie==='admin_session=2'){expired=false;return Response.json({}, {status:401});}return Response.json({permissions:revoked&&options.headers.cookie==='admin_session=owner'?[]:['*']});}
  if(u.pathname.endsWith('/auth/logout'))return Response.json({});
  if(u.pathname==='/v1/admin/assistant/tracking'){
   const index=Number(u.searchParams.get('cursor')??0),offset=['grocery','jewelry','electronics','pharmacy'].indexOf(store);
   return Response.json({items:Array.from({length:25},(_,i)=>({request_id:`${store}-${index+i}`,created_at:new Date(Date.UTC(2026,9,10)-((index+i)*4+offset)*1000).toISOString(),question_preview:store+' message',report_available:true})),next_cursor:index<50?String(index+25):null,capture_enabled:store!=='electronics',retention_days:7});
  }
  return Response.json({});
 };
 let server,base,cookie='';
 const start=async()=>{server=createApp(config,fetcher);server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;};
 const stop=async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));};
 await start();t.after(stop);
 const request=(path,input)=>fetch(base+path,{method:input?'POST':'GET',headers:{cookie,'x-rengine-request':'1','content-type':'application/json'},...(input?{body:JSON.stringify(input)}:{})});
 const login=async(email='owner@test.local')=>{const response=await request('/api/login',{store:'grocery',email,password:'password-secret'});cookie=response.headers.get('set-cookie').split(';')[0];return response.json();};
 const save=store=>request('/api/connections',{action:'save',store,email:store+'@test.local',password:'saved-password-secret'});
 return {dir,config,request,login,save,calls,getCookie:()=>cookie,setCookie:value=>{cookie=value;},expireOwner:()=>{ownerExpired=true;},rejectOwner:()=>{rejectOwner=true;},restart:async()=>{await stop();await start();},revoke:()=>{revoked=true;},expire:()=>{expired=true;},down:()=>{down=true;},logins:()=>logins};
}
test('saved connections are encrypted, write-only, owner protected and restored after restart',async t=>{
 const f=await setup(t);assert.equal((await f.request('/api/connections')).status,401);assert.equal((await f.request('/api/all-traces')).status,401);
 await f.login('reader@test.local');assert.equal((await f.save('jewelry')).status,403);assert.equal((await f.request('/api/connections')).status,403);
 await f.login();assert.equal((await f.save('jewelry')).status,200);assert.equal(statSync(f.dir+'/connections').mode&0o777,0o600);
 assert.ok(!readFileSync(f.dir+'/connections').includes('saved-password-secret'));
 const metadata=await(await f.request('/api/connections')).text();assert.ok(!metadata.includes('saved-password-secret'));assert.ok(!metadata.includes('admin_session'));
 await f.restart();const restored=await f.login();assert.deepEqual(restored.stores,['grocery','jewelry']);assert.equal(restored.operator,true);
 assert.equal((await f.request('/api/traces?store=jewelry')).status,200);
 f.revoke();assert.equal((await f.request('/api/traces?store=jewelry')).status,403);assert.equal((await f.request('/api/connections')).status,401);
});
test('expired saved demo sessions renew automatically; invalid updates preserve the working account; remove revokes access',async t=>{
 const f=await setup(t);await f.login();await f.save('jewelry');f.expire();const before=f.logins();assert.equal((await f.request('/api/traces?store=jewelry')).status,200);assert.equal(f.logins(),before+1);
 assert.equal((await f.request('/api/connections',{action:'save',store:'jewelry',email:'new@test.local',password:'wrong'})).status,400);
 assert.equal((await(await f.request('/api/connections')).json()).connections.find(x=>x.store==='jewelry').email,'jewelry@test.local');
 assert.equal((await f.request('/api/connections',{action:'remove',store:'jewelry'})).status,200);assert.equal((await f.request('/api/traces?store=jewelry')).status,401);
});
test('combined pages stay globally ordered without duplicates and expose outages and per-demo capture state',async t=>{
 const f=await setup(t);await f.login();for(const store of ['jewelry','electronics','pharmacy'])await f.save(store);
 let cursor='',rows=[];
 for(let i=0;i<8;i++){const response=await f.request('/api/all-traces?hours=72'+(cursor?'&cursor='+cursor:''));assert.equal(response.status,200);const data=await response.json();assert.equal(data.items.length,25);rows.push(...data.items);cursor=data.next_cursor;assert.equal(data.demos.find(d=>d.store==='electronics').capture_enabled,false);}
 assert.equal(new Set(rows.map(r=>r.request_id)).size,200);for(let i=1;i<rows.length;i++)assert.ok(Date.parse(rows[i-1].created_at)>=Date.parse(rows[i].created_at));
 assert.equal((await f.request('/api/all-traces?hours=24&cursor='+cursor)).status,400);
 f.down();const partial=await(await f.request('/api/all-traces')).json();assert.equal(partial.demos.find(d=>d.store==='pharmacy').status,502);assert.ok(partial.items.every(r=>r.store!=='pharmacy'));
 const filtered=await(await f.request('/api/all-traces?demo=electronics')).json();assert.ok(filtered.items.every(r=>r.store==='electronics'));
});
test('vault fails closed if its encryption key changes',async t=>{const f=await setup(t);await f.login();await f.save('jewelry');writeFileSync(f.dir+'/key',randomBytes(32));assert.throws(()=>connectionVault(f.config),/Cannot open/);});

test('operator login does not require choosing a demo and returns saved connections immediately',async t=>{
 const f=await setup(t);await f.login();await f.save('jewelry');await f.request('/api/logout',{});
 const response=await f.request('/api/login',{email:'owner@test.local',password:'password-secret'});
 assert.equal(response.status,200);const data=await response.json();assert.equal(data.operator,true);assert.deepEqual(data.stores,['grocery','jewelry']);
 assert.ok(response.headers.get('set-cookie').includes('HttpOnly'));
});

test('remembered operator survives restart, renews expired upstream auth, and logout revokes cookie replay',async t=>{
 const f=await setup(t);await f.login();await f.save('jewelry');const cookie=f.getCookie();
 const bytes=readFileSync(f.dir+'/connections.sessions');assert.ok(!bytes.includes('password-secret'));assert.ok(!bytes.includes(cookie.split('=')[1]));assert.equal(statSync(f.dir+'/connections.sessions').mode&0o777,0o600);
 await f.restart();f.expireOwner();const before=f.logins();
 const restored=await f.request('/api/session');assert.equal(restored.status,200);assert.deepEqual((await restored.json()).stores,['grocery','jewelry']);assert.equal(f.logins(),before+1);
 assert.equal((await f.request('/api/connections')).status,200);
 await f.request('/api/logout',{});await f.restart();f.setCookie(cookie);assert.equal((await f.request('/api/session')).status,401);
});
test('remembered login has a 30-day persistent cookie and expiry remains enforced after restart',async t=>{
 const f=await setup(t);const response=await f.request('/api/login',{email:'owner@test.local',password:'password-secret'});
 const cookie=response.headers.get('set-cookie');const age=Number(cookie.match(/Max-Age=(\d+)/)[1]);assert.ok(age>=2591990&&age<=2592000);assert.match(cookie,/HttpOnly; SameSite=Strict/);f.setCookie(cookie.split(';')[0]);
 rememberedSessions(f.config).set(sessionKey(f.getCookie().split('=')[1]),{expires:Date.now()-1,ownerCookie:'admin_session=owner',ownerCredentials:{email:'owner@test.local',password:'password-secret'}});
 await f.restart();assert.equal((await f.request('/api/session')).status,401);
});
test('rejected operator credentials invalidate remembered login instead of renewing forever',async t=>{
 const f=await setup(t);await f.login();f.expireOwner();f.rejectOwner();assert.equal((await f.request('/api/session')).status,401);
 await f.restart();assert.equal((await f.request('/api/session')).status,401);
});

test('remembered sessions fail closed with a different key or configured operator',async t=>{
 const f=await setup(t);await f.login();assert.equal(rememberedSessions({...f.config,ownerEmail:'other@test.local'}).entries().length,0);
 writeFileSync(f.dir+'/key',randomBytes(32));assert.throws(()=>rememberedSessions(f.config),/Cannot open remembered sessions/);
});
