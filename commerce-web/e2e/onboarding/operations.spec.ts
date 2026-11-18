import {test,expect} from '@playwright/test';
test('staff reviews clients, confirms payment and requests suspension/archive explicitly',async({page},testInfo)=>{
 const id='11111111-1111-4111-8111-111111111111',pid='22222222-2222-4222-8222-222222222222';
 let managementState='ENABLED',paymentStatus='AWAITING_PAYMENT',hostingProvider:string|null=null;const commands:Record<string,unknown>[]=[];const writes:Record<string,unknown>[]=[];
 const store=()=>({id,slug:'fixture-store',brand:'Fixture Grocery',plan:'LAUNCH',lifecycle:'QUEUED',managementState,hostingProvider,hostingLocked:false,email:'fixture@example.test',theme:'grocery',createdAt:'2026-11-12T10:00:00Z'});
 await page.route('**/api/control/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname.replace('/api/control/','');
  if(path==='me')return route.fulfill({json:{id:'staff',email:'owner@example.test',role:'OWNER'}});
  if(path==='dashboard')return route.fulfill({json:{counts:{clients:1,active:0,awaitingPayment:paymentStatus==='CONFIRMED'?0:1,setupAttention:1},jobs:[{id:'job',tenantId:id,slug:'fixture-store',brand:'Fixture Grocery',status:'BLOCKED',step:'RELEASE',reason:'APPROVED_RELEASE_REQUIRED',attempts:0,updatedAt:'2026-11-12T10:00:00Z',managementState}],payments:[{id:pid,tenantId:id,slug:'fixture-store',email:'fixture@example.test',amountMinor:100,currency:'EGP',serviceDays:30,status:paymentStatus,receiptReference:paymentStatus==='CONFIRMED'?'TEST-RECEIPT':null,managementState}],activity:[]}});
  if(path==='clients')return route.fulfill({json:{items:[{id:'account',email:'fixture@example.test',verified:true,stores:[store()]}],total:1,page:0}});
  if(path===`stores/${id}`)return route.fulfill({json:{store:store(),commands,steps:[],hosts:[]}});
  if(path===`payments/${pid}/confirm`){writes.push(request.postDataJSON());paymentStatus='CONFIRMED';return route.fulfill({json:{status:'CONFIRMED',code:'123456'}});}
  if(path===`stores/${id}/hosting`){hostingProvider=request.postDataJSON().provider;return route.fulfill({json:{provider:hostingProvider}});}
  if(path===`stores/${id}/control`){const body=request.postDataJSON();writes.push(body);managementState=body.action==='SUSPEND'?'SUSPENDED':'ARCHIVED';commands.unshift({id:String(commands.length),action:body.action,reason:body.reason,status:'APPLIED',requestedAt:'2026-11-12T10:00:00Z'});return route.fulfill({json:{status:'PENDING'}});}
  return route.fulfill({status:404,json:{code:'NOT_FOUND'}});
 });
 await page.goto('http://127.0.0.1:3101');
 await expect(page.getByRole('heading',{name:'Overview',exact:true})).toBeVisible();
 await page.screenshot({path:testInfo.outputPath('ops-overview.png'),fullPage:true});
 await page.getByRole('button',{name:'Payments',exact:true}).click();
 await page.getByRole('button',{name:'Verify & generate code'}).click();
 await expect(page.getByRole('button',{name:'Generate six-digit code',exact:true})).toBeDisabled();
 await page.getByLabel('Receipt reference').fill('TEST-RECEIPT');
 await page.getByRole('checkbox').check();
 await page.getByRole('button',{name:'Generate six-digit code',exact:true}).click();
 await expect(page.getByText('TEST-RECEIPT',{exact:true})).toBeVisible();
 expect(writes[0]).toEqual({receiptReference:'TEST-RECEIPT',amountMinor:100,currency:'EGP',serviceDays:30});
 await page.getByRole('button',{name:'Clients',exact:true}).click();
 await page.getByRole('button',{name:'Manage →'}).click();
 await expect(page.getByRole('region',{name:'Store setup status'}).getByText('blocked',{exact:true})).toBeVisible();
 await expect(page.getByRole('region',{name:'Store setup status'}).getByText('release',{exact:true})).toBeVisible();
 await page.getByLabel('Cloud provider').selectOption('gcp');
 await page.getByRole('button',{name:'Save hosting selection',exact:true}).click();
 await expect(page.getByText('Google Cloud',{exact:true}).first()).toBeVisible();
 expect(hostingProvider).toBe('gcp');
 await page.getByRole('button',{name:'Suspend store',exact:true}).click();
 await page.getByLabel('Reason',{exact:true}).fill('Synthetic suspension test');
 await page.getByLabel('Type fixture-store to confirm').fill('wrong');
 await expect(page.getByRole('button',{name:'Request suspension'})).toBeDisabled();
 await page.getByLabel('Type fixture-store to confirm').fill('fixture-store');
 await page.getByRole('button',{name:'Request suspension'}).click();
 await expect(page.getByRole('button',{name:'Suspend store',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Archive store',exact:true}).click();
 await page.getByLabel('Reason',{exact:true}).fill('Synthetic archive test');
 await page.getByLabel('Type fixture-store to confirm').fill('fixture-store');
 await page.getByRole('button',{name:'Request archive'}).click();
 await expect(page.getByRole('button',{name:'Archive store',exact:true})).toBeDisabled();
 expect(writes[1].action).toBe('SUSPEND');expect(writes[2].action).toBe('ARCHIVE');
 await page.setViewportSize({width:390,height:844});
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:testInfo.outputPath('ops-store-mobile.png'),fullPage:true});
});


for(const provider of ['aws','gcp','hetzner']){
 test(`staff selects ${provider}; placement locks and viewer access stay read-only`,async({page})=>{
  const id='11111111-1111-4111-8111-111111111111',host='33333333-3333-4333-8333-333333333333';let role='OWNER',locked=false,chosen:string|null=null;
  const writes:unknown[]=[];
  const store=()=>({id,slug:'fleet-fixture',brand:'Fleet fixture',plan:'LAUNCH',lifecycle:'QUEUED',managementState:'ENABLED',hostingProvider:chosen,hostingLocked:locked});
  await page.route('**/api/control/**',async route=>{
   const req=route.request(),path=new URL(req.url()).pathname.replace('/api/control/','');
   if(path==='me')return route.fulfill({json:{id:'staff',email:'staff@example.test',role}});
   if(path==='dashboard')return route.fulfill({json:{counts:{clients:1,active:0,awaitingPayment:0,setupAttention:0},jobs:[],payments:[],activity:[]}});
   if(path==='clients')return route.fulfill({json:{items:[{id:'client',email:'client@example.test',verified:true,stores:[store()]}],total:1,page:0}});
   if(path===`stores/${id}`)return route.fulfill({json:{store:store(),commands:[],steps:[],hosts:[{id:host,provider,reference:"i-selected",state:"READY",usedSlots:2,maxSlots:3},{id:"44444444-4444-4444-8444-444444444444",provider,reference:"i-full",state:"READY",usedSlots:3,maxSlots:3}]}});
   if(path===`stores/${id}/hosting`){const body=req.postDataJSON();writes.push(body);chosen=body.provider;locked=true;return route.fulfill({json:{provider:chosen}});}
   return route.fulfill({status:404,json:{code:'NOT_FOUND'}});
  });
  await page.goto('http://127.0.0.1:3101');
  await page.getByRole('button',{name:'Clients',exact:true}).click();
  await page.getByRole('button',{name:'Manage →'}).click();
  await expect(page.getByText('Waiting for worker',{exact:true})).toBeVisible();
  await expect(page.getByText('Payment is confirmed. The provisioning worker has not created a job yet.')).toBeVisible();
  await expect(page.getByRole('button',{name:'Save hosting selection'})).toBeDisabled();
  await page.getByLabel('Cloud provider').selectOption(provider);
  await expect(page.getByRole('option',{name:'i-full — 3/3 clients — ready'})).toHaveJSProperty('disabled',true);
  await page.getByRole('combobox',{name:'Instance',exact:true}).selectOption(host);
  await page.getByRole('button',{name:'Save hosting selection'}).click();
  await expect(page.getByText('Placement is locked. Changing providers requires a store migration.')).toBeVisible();
  await expect(page.getByLabel('Cloud provider')).toHaveCount(0);
  expect(writes).toEqual([{provider,hostId:host}]);
  role='VIEWER';locked=false;await page.reload();
  await page.getByRole('button',{name:'Clients',exact:true}).click();
  await page.getByRole('button',{name:'Manage →'}).click();
  await expect(page.getByText('Your role has read-only access.')).toBeVisible();
  await expect(page.getByRole('button',{name:'Save hosting selection'})).toHaveCount(0);
  expect(writes).toHaveLength(1);
 });
}

for (const theme of ['grocery', 'jewelry', 'electronics', 'pharmacy']) {
 test(`store details show ${theme} setup even outside the dashboard job window`, async ({page}) => {
  const id='11111111-1111-4111-8111-111111111111';
  const store={id,slug:'jeww',brand:'Jeww',theme,plan:'STARTER',lifecycle:'QUEUED',managementState:'ENABLED',hostingProvider:'aws',hostingLocked:false};
  await page.route('**/api/control/**',async route=>{
   const path=new URL(route.request().url()).pathname.replace('/api/control/','');
   if(path==='me')return route.fulfill({json:{id:'staff',email:'staff@example.test',role:'OWNER'}});
   if(path==='dashboard')return route.fulfill({json:{counts:{clients:1,active:0,awaitingPayment:0,setupAttention:0},jobs:[],payments:[],activity:[]}});
   if(path==='clients')return route.fulfill({json:{items:[{id:'client',email:'client@example.test',verified:true,stores:[store]}],total:1,page:0}});
   if(path===`stores/${id}`)return route.fulfill({json:{store,hosts:[],commands:[],steps:[],job:{id:'job',tenantId:id,status:'BLOCKED',step:'RELEASE',reason:'APPROVED_RELEASE_REQUIRED',attempts:0,updatedAt:'2026-11-18T10:00:00Z'}}});
   return route.fulfill({status:404,json:{code:'NOT_FOUND'}});
  });
  await page.goto('http://127.0.0.1:3101');
  await page.getByRole('button',{name:'Clients',exact:true}).click();
  await page.getByRole('button',{name:'Manage →'}).click();
  const panel=page.getByRole('region',{name:'Store setup status'});
  await expect(panel.getByText('blocked',{exact:true})).toBeVisible();
  await expect(panel.getByText('release',{exact:true})).toBeVisible();
  await expect(panel.getByText(`The selected ${theme} release needs approval before setup can continue.`)).toBeVisible();
 });
}
