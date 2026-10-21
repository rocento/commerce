import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {build}=createRequire(require.resolve('vite'))('esbuild');
import {chromium,expect} from '../../node_modules/@playwright/test/index.mjs';
import {createServer} from 'node:http';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const appStudioSrc=resolve(dirname(fileURLToPath(import.meta.url)),'../../apps/mobile-studio/src');
const entry=`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {NativePreviewVideo} from './native-preview-video';
const nativeDecode=window.createImageBitmap;
window.createImageBitmap=async(...args)=>{await new Promise(r=>setTimeout(r,50));return nativeDecode(...args)};
const make=color=>{const c=document.createElement('canvas');c.width=32;c.height=64;const ctx=c.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,32,64);return Uint8Array.from(atob(c.toDataURL('image/jpeg').split(',')[1]),x=>x.charCodeAt(0))};
const frames=Array.from({length:20},(_,i)=>make(i===19?'#0000ff':'#ff0000'));
const bytes=new Uint8Array(frames.reduce((n,f)=>n+4+f.length,4));let offset=0;
for(const frame of frames){new DataView(bytes.buffer).setUint32(offset,frame.length,true);bytes.set(frame,offset+4);offset+=4+frame.length}
window.__connections=0;
window.fetch=async(url,options)=>{window.__connections++;return new Response(new ReadableStream({start(c){
 c.enqueue(bytes.slice(0,3));c.enqueue(bytes.slice(3));
 const f=make('#0000ff'),packet=new Uint8Array(f.length+4);new DataView(packet.buffer).setUint32(0,f.length,true);packet.set(f,4);window.__pushFrame=()=>c.enqueue(packet);window.__pushTimed=age=>{const jpeg=new Uint8Array(f.length+16);jpeg.set(f.slice(0,2));jpeg.set([255,254,0,14,82,79,67,84],2);new DataView(jpeg.buffer).setFloat64(10,Date.now()-age);jpeg.set(f.slice(2),18);const p=new Uint8Array(jpeg.length+4);new DataView(p.buffer).setUint32(0,jpeg.length,true);p.set(jpeg,4);c.enqueue(p);};
 options.signal.addEventListener('abort',()=>c.error(new DOMException('Aborted','AbortError')));
}}),{headers:{'Content-Type':'application/x-rocento-mjpeg'}});};
createRoot(document.getElementById('root')).render(<NativePreviewVideo merchant="fixture" session="fixture" platform="android"/>);
`;
const bundle=await build({stdin:{contents:entry,resolveDir:appStudioSrc,loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic'});
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<div id="root"></div><script>${bundle.outputFiles[0].text}</script>`)});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
 const canvas=page.getByRole('application',{name:'Interactive Android preview'});
 await expect(canvas).toHaveAttribute('data-live','true');
 const value=await canvas.evaluate(c=>({frames:Number(c.dataset.frames),pixel:Array.from(c.getContext('2d').getImageData(16,32,1,1).data)}));
 expect(value.frames).toBeLessThanOrEqual(2);expect(value.pixel[2]).toBeGreaterThan(240);expect(value.pixel[0]).toBeLessThan(20);
 const before=Number(await canvas.getAttribute('data-frames'));
 await page.evaluate(()=>new Promise(resolve=>{const timer=setInterval(()=>window.__pushFrame(),10);setTimeout(()=>{clearInterval(timer);resolve()},600)}));
 expect(Number(await canvas.getAttribute('data-frames'))-before).toBeGreaterThanOrEqual(5);
 await page.evaluate(()=>window.__pushTimed(-3600000));await page.waitForTimeout(100);
 await page.evaluate(()=>window.__pushTimed(-3595000));
 await expect.poll(()=>page.evaluate(()=>window.__connections)).toBeGreaterThanOrEqual(2);
 await page.evaluate(()=>window.__pushTimed(3600000));await page.waitForTimeout(100);
 await page.evaluate(()=>window.__pushTimed(3605000));
 await expect.poll(()=>page.evaluate(()=>window.__connections)).toBeGreaterThanOrEqual(3);
 await page.evaluate(()=>window.dispatchEvent(new Event('offline')));await page.waitForTimeout(150);
 await expect(canvas).toHaveAttribute('data-live','false');
 expect(await canvas.evaluate(c=>c.getContext('2d').getImageData(16,32,1,1).data[3])).toBe(0);
 console.log(JSON.stringify({latestFramePresented:true,continuousInputDoesNotStarvePaint:true,historyDiscarded:true,staleTransportReconnects:true,clockSkewTolerated:true,partialHeaderAndHeartbeatHandled:true,offlineClearsFrame:true,presentedFrames:value.frames}));
}finally{await browser.close();server.close()}
