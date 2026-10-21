// Test-only wrapper: real production template/render function, localhost metrics control port.
import {readFile} from 'node:fs/promises';import {createServer} from 'node:http';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';
const root=resolve(import.meta.dirname,'../../../../..');const {createPublicationServer}=await import(pathToFileURL(root+'/frontend/apps/storefront/server/publication.mjs'));
const {gatewayFetch}=await import(pathToFileURL(root+'/frontend/apps/storefront/server/transport.mjs'));
const artifacts=process.env.PUBLICATION_ARTIFACT_DIR;const {render}=await import(pathToFileURL(process.env.PUBLICATION_SSR_ENTRY));
let calls=0;let active=0;let peak=0;let time=0;const cpu=process.cpuUsage();
const server=createPublicationServer({origin:process.env.PUBLICATION_APPROVED_ORIGIN,installationId:process.env.PUBLICATION_INSTALLATION_ID,gateway:process.env.PUBLICATION_GATEWAY,template:await readFile(artifacts+'/public.html','utf8'),assetDirectory:artifacts,render,emitObservation:()=>{},fetcher:async(...args)=>{calls++;active++;peak=Math.max(peak,active);const start=performance.now();try{return await gatewayFetch(...args);}finally{active--;time+=performance.now()-start;}}});
// Used only by the benchmark harness; this endpoint is not in the production server.
const metrics=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({calls,peak_gateway_concurrency:peak,gateway_total_ms:time,cpu:process.cpuUsage(cpu),memory:process.memoryUsage(),resource:process.resourceUsage(),node:process.version}));});
await new Promise(r=>metrics.listen(0,'127.0.0.1',r));
await new Promise(r=>server.listen(0,'127.0.0.1',r));console.log(JSON.stringify({port:server.address().port}));
await import('node:fs/promises').then(fs=>fs.writeFile(process.env.STAGE11_CONTROL_FILE,JSON.stringify({port:metrics.address().port})));
