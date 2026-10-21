// Local component integration: real grid, API client and moderation dialog, mocked HTTP.
// Run: node commerce-web/e2e/reviews-local.mjs
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../apps/admin/', import.meta.url));
const html = root + '__reviews_check.html';
const entry = root + '__reviews_check.tsx';
let server, browser;
try {
  await writeFile(html, '<div id="root"></div><script type="module" src="/__reviews_check.tsx"></script>');
  await writeFile(entry, `import React from 'react'; import {createRoot} from 'react-dom/client'; import {QueryClient,QueryClientProvider} from '@tanstack/react-query'; import {Reviews} from './src/reviews'; import '@commerce/ui/styles.css'; import './src/style.css'; createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><div className="admin-body"><Reviews canModerate={!location.search.includes('readonly')}/></div></QueryClientProvider>);`);
  server = await createServer({ root, server: { host: '127.0.0.1', port: 5189, strictPort: true } });
  await server.listen();
  browser = await chromium.launch({headless:true});
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  let fail = false, conflict = false, writes=[];
  const seen=[];
  const rows=['pending','approved','rejected'].map((status,i)=>({id:`00000000-0000-4000-8000-00000000000${i+1}`,product_id:'00000000-0000-4000-8000-000000000099',customer_id:'00000000-0000-4000-8000-000000000088',display_name:['Amina','Omar','Nour'][i],title:['Fresh and carefully packed','Reliable delivery','Packaging could improve'][i],body:'The product arrived on time. Here is my honest feedback about the quality and packaging.',rating:5-i,status,version:2,moderation_reason:i?'Reviewed against our publication guidelines.':null,created_at:'2026-09-27T10:30:00Z',updated_at:'2026-09-28T12:00:00Z'}));
  await page.route('**/api/**',async route=>{
    const req=route.request(),url=new URL(req.url());
    const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(url.pathname.endsWith('/grids/reviews/sorts')) return json(['id','created_at']);
    if(url.pathname.endsWith('/grids/reviews')) {seen.push(url);if(fail)return json({error:'Review service unavailable'},503);return json({items:rows.filter(r=>!url.searchParams.get('status')||r.status===url.searchParams.get('status')),next_cursor:null,total_count:url.searchParams.get('status')?1:3});}
    if(req.method()==='PUT'&&url.pathname.includes('/admin/reviews/')) {writes.push(req.postDataJSON());if(conflict)return json({error:'Review changed by another moderator'},409);rows[0].status=req.postDataJSON().status;return json(rows[0]);}
    if(url.pathname.includes('/products/')) return json({id:rows[0].product_id,name:'Gala Apples 1kg',sku:'GRO-002',price:'2.50',currency:'USD',media_ids:[],attributes:{}});
    return json({error:'Unexpected API '+url.pathname},404);
  });
  const visit=()=>page.goto('http://127.0.0.1:5189/__reviews_check.html');
  await visit();
  await expect(page.locator('.review-card')).toHaveCount(3);
  if(seen[0].searchParams.has('status')||seen[0].searchParams.has('q'))throw Error('Default filters applied');
  await expect(page.getByLabel('Status',{exact:true})).toHaveValue('');
  await page.getByLabel('Status',{exact:true}).selectOption('pending');
  await expect(page.locator('.review-card')).toHaveCount(1);
  await page.getByRole('button',{name:'Clear filters',exact:true}).click();
  await expect(page.locator('.review-card')).toHaveCount(3);
  await page.getByRole('button',{name:'Review decision',exact:true}).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button',{name:'Approve and publish'})).toBeDisabled();
  await page.getByLabel('Decision reason',{exact:false}).fill('  Meets our review guidelines.  ');
  conflict=true;
  await page.getByRole('button',{name:'Approve and publish'}).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  conflict=false;
  await page.getByRole('button',{name:'Review decision',exact:true}).first().click();
  await page.getByLabel('Decision reason',{exact:false}).fill('  Meets our review guidelines.  ');
  await page.getByRole('button',{name:'Approve and publish'}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Review approved and published.',{exact:true})).toBeVisible();
  if(writes.at(-1).expected_version!==2||writes.at(-1).reason!=='Meets our review guidelines.')throw Error('Moderation contract incorrect');
  await page.screenshot({path:'/tmp/admin-reviews-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'/tmp/admin-reviews-mobile.png',fullPage:true});
  if(await page.locator('.review-card').evaluateAll(cards=>cards.some(c=>c.querySelector('header').getBoundingClientRect().bottom>c.querySelector('.review-body').getBoundingClientRect().top)))throw Error('Review header overlaps content');
  if(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth))throw Error('Mobile horizontal overflow');
  await page.goto('http://127.0.0.1:5189/__reviews_check.html?readonly');
  await expect(page.locator('.review-card')).toHaveCount(3);
  await expect(page.getByRole('button',{name:'Review decision',exact:true})).toHaveCount(0);
  fail=true;
  await page.getByRole('button',{name:/Refresh/}).click();
  await expect(page.getByRole('heading',{name:'Reviews could not be loaded'})).toBeVisible();
  fail=false;
  await page.getByRole('button',{name:'Retry loading reviews'}).click();
  await expect(page.locator('.review-card')).toHaveCount(3);
  if(errors.length)throw Error(errors.join('\n'));
  console.log('PASS: unfiltered default; all statuses; filter/reset; required reason; versioned moderation; conflict retention; refresh; read-only permissions; API recovery; responsive layouts.');
} finally {await browser?.close();await server?.close();await rm(html,{force:true});await rm(entry,{force:true});}
