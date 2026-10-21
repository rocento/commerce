import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {traceBoundary} from '../src/trace-boundary.ts';
test('private trace context is bounded and rejects malformed or duplicate headers',()=>{
 for(const value of [undefined,['a','b'],'',`2/${randomUUID()}/span-1`,`1/${randomUUID()}/`, `1/${randomUUID()}/${'x'.repeat(65)}`,`1/${randomUUID()}/span/extra`])assert.equal(traceBoundary(value),null);
 const context=`1/${randomUUID()}/span-1`,end=traceBoundary(context)!;
 const parts=end().split('/');assert.equal(parts.slice(0,3).join('/'),context);assert.match(parts[3],/^[a-f0-9-]{36}$/);assert.ok(Number(parts[4])>=0);
});
test('HTTP boundary returns only matched identifiers and local elapsed time',async()=>{
 const server=createServer((req,res)=>{const end=traceBoundary(req.headers['x-commerce-trace-request']);if(end)res.setHeader('x-commerce-trace-response',end());res.end('{}');});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try {const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;const context=`1/${randomUUID()}/span-2`;
 const response=await fetch(url,{headers:{'x-commerce-trace-request':context}});assert.ok(response.headers.get('x-commerce-trace-response')!.startsWith(context+'/'));
 assert.equal((await fetch(url)).headers.get('x-commerce-trace-response'),null);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
