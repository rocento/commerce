// Development-only visual fixtures. All commerce requests stay in memory;
// this module never reads production SecureStore or falls back to the network.
import { useMemo, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Pressable, View, Text } from 'react-native';
import { CommerceClient, merchant, type Cart, type Transport } from '../core/commerce';
import { LiveStorefront } from '../ui/LiveStorefront';
import fixture from './commerce-flow.json';
import type { ReorderDraft, ReorderProposal } from '../core/reorder';
import type { Review } from '../core/reviews';
import type { SupportDetail } from '../core/support';
import type { MemoryView, SavedGoal } from '../core/assistantLibrary';

type Scenario = 'Guest' | 'Customer' | 'Empty' | 'Unverified';
function configuration(scenario: Scenario) {
  const memory = new Map<string, string>();
  if (scenario !== 'Guest') memory.set(`rocento.rn.v1.production.${merchant.id}.refresh`, 'f'.repeat(64));
  const customer = { ...fixture.customer, email: 'shopper@example.test', verified: scenario !== 'Unverified' };
  let savedIDs = scenario === 'Empty' ? [] : [fixture.variant.id];
  let counter = 1;
  let proposalApplied = false;
  const ownReviews = new Map<string, Review>();
  const support = new Map<string, SupportDetail>();
  const supportRequests = new Map<string, { payload: string; id: string }>();
  const reorders = new Map<string, ReorderProposal>();
  const tasks = new Map<string, string>();
  const conversation='90000000-0000-4000-8000-000000000301';
  let memoryView:MemoryView={enabled:true,guest:scenario==='Guest',personalized:false,journey_consent:false,consent_version:1,expires_at:null,preferences:[],signals:[],categories:fixture.categories,products:[]};
  let goals:SavedGoal[]=[{task_id:conversation,name:'Weekly fruit',archived:false,version:1,state:'draft',expires_at:new Date(Date.now()+86400000).toISOString()}];
  let cart: Cart = structuredClone(scenario === 'Empty' ? fixture.empty_cart : fixture.cart);
  const respond = (body: unknown, auth = false) => {
    const result = new Response(JSON.stringify(body), { status: 200 });
    // Browser Response filters Set-Cookie. The isolated transport supplies the
    // native response-header contract directly; no real cookies are written.
    if (auth) Object.defineProperty(result, 'headers', { value: { get: (name: string) => name.toLowerCase() === 'set-cookie' ? `customer_refresh=${'f'.repeat(64)}; HttpOnly; Secure` : null } });
    return result;
  };
  const transport: Transport = async (url, init) => {
    const parsed = new URL(url); const path = parsed.pathname.replace('/api/', '');
    const ar = new Headers(init.headers).get('X-Storefront-Locale') === 'ar';
    const product = { ...fixture.product, name: ar ? 'تفاح طازج' : 'Fresh apples', description: ar ? 'تفاح مقرمش وطازج لمائدتك كل يوم.' : 'Crisp, fresh apples for your everyday table.' };
    const variant = { ...fixture.variant, name: ar ? 'تفاح — ١ كجم' : 'Apples — 1 kg' };
    if(path==='v1/assistant/history')return respond([{conversation_id:conversation,request_id:conversation,question:ar?'فاكهة الأسبوع':'Weekly fruit',answer:ar?'اقتراح محفوظ':'Saved suggestion',created_at:'2026-10-13T00:00:00Z',blocks:[{kind:'product_card',products:[{id:variant.id,name:variant.name,price:variant.price,currency:variant.currency,route:`/products/${variant.id}`,reasons:[],unmet:[],attributes:[]}],sources:[{kind:'catalog',product_id:variant.id,route:`/products/${variant.id}`}]}]}]);
    if(path==='v1/assistant/memory') {
      if(init.method==='PUT'){const input=JSON.parse(init.body as string);if(input.expected_version!==memoryView.consent_version)return new Response('{}',{status:409});memoryView={...memoryView,personalized:input.personalized,journey_consent:input.journey,consent_version:memoryView.consent_version+1};}
      if(init.method==='DELETE')memoryView={...memoryView,personalized:false,journey_consent:false,preferences:[],signals:[],consent_version:memoryView.consent_version+1};
      memoryView={...memoryView,categories:fixture.categories.map(c=>({...c,name:ar?'الفاكهة':'Fresh fruit'}))};
      const result=respond(memoryView);if(scenario==='Guest')Object.defineProperty(result,'headers',{value:{get:(name:string)=>name.toLowerCase()==='set-cookie'?`assistant_guest=${'g'.repeat(48)}; HttpOnly`:null}});return result;
    }
    if(path==='v1/assistant/memory/preferences') {const input=JSON.parse(init.body as string);memoryView.preferences=memoryView.preferences.filter(p=>p.id!==input.replaces);memoryView.preferences.push({...input,id:`90000000-0000-4000-8000-${String(counter++).padStart(12,'0')}`,signal:input.dislike?'explicit_dislike':'explicit_like'});if(input.value==='INTERRUPT')throw new Error('Isolated lost memory response');return respond({ok:true});}
    if(path.startsWith('v1/assistant/memory/preferences/')){memoryView.preferences=memoryView.preferences.filter(p=>p.id!==path.split('/').at(-1));return respond({ok:true});}
    if(path.startsWith('v1/assistant/memory/context/'))return respond({ok:true});
    if(path==='v1/assistant/memory/export')return respond({schema_version:'1.0.0',memory:memoryView,contexts:[],consents:[]});
    if(path==='v1/cart/saved-goals')return respond({goals});
    if(path.startsWith('v1/cart/saved-goals/')){const goal=goals.find(g=>g.task_id===path.split('/').at(-1));if(!goal)return new Response('{}',{status:404});if(init.method==='DELETE'){if(Number(parsed.searchParams.get('version'))!==goal.version)return new Response('{}',{status:409});goals=goals.filter(g=>g!==goal);}else{const input=JSON.parse(init.body as string);if(input.expected_version!==goal.version)return new Response('{}',{status:409});Object.assign(goal,{name:input.name,archived:input.archived,version:goal.version+1});}return respond({ok:true});}
    if (scenario !== 'Empty') Object.assign(product, { catalog_offer: { product_id: product.id, currency: product.currency, original_price: product.price, discounted_price: '20.00' } });
    if (path === 'v1/customer/wishlist') return respond(savedIDs);
    if (path === 'v1/support/session') {
      const result=respond({status:'ok'});Object.defineProperty(result,'headers',{value:{get:(name:string)=>name.toLowerCase()==='set-cookie'?`support_guest=${'g'.repeat(48)}; HttpOnly`:null}});return result;
    }
    if(path === 'v1/customer/support/tickets')return respond([...support.values()].map(d=>d.ticket));
    if(path === 'v1/support/tickets' && init.method === 'POST') {
      const input=JSON.parse(init.body as string),previous=supportRequests.get(input.request_id);
      if(previous)return previous.payload===init.body?respond(support.get(previous.id)):new Response('{}',{status:409});
      const id=`90000000-0000-4000-8000-${String(counter++).padStart(12,'0')}`;
      const detail:SupportDetail={ticket:{id,number:42,subject:input.subject,category:input.category,status:'open',priority:input.category==='payment_dispute'?'high':'normal',order_id:input.order_id,created_at:'2026-10-13T00:00:00Z'},messages:[{id,sender:'customer',body:input.body,created_at:'2026-10-13T00:00:00Z'}]};
      support.set(id,detail);supportRequests.set(input.request_id,{payload:init.body as string,id});
      if(input.subject==='INTERRUPT')throw new Error('Isolated lost ticket response');return respond(detail);
    }
    if(/^v1\/customer\/support\/tickets\/[^/]+(?:\/messages)?$/.test(path)) {
      const id=path.split('/')[4]!,detail=support.get(id);if(!detail)return new Response('{}',{status:404});
      if(init.method==='POST') {
        const input=JSON.parse(init.body as string),previous=supportRequests.get(input.request_id);
        if(previous)return previous.payload===init.body&&previous.id===id?respond(detail):new Response('{}',{status:409});
        detail.messages.push({id:input.request_id,sender:'customer',body:input.body,created_at:'2026-10-13T01:00:00Z'});detail.ticket.status='in_progress';
        supportRequests.set(input.request_id,{payload:init.body as string,id});
        if(input.body==='INTERRUPT REPLY')throw new Error('Isolated lost support reply');
      }
      return respond(detail);
    }
    if (/^v1\/products\/[^/]+\/reviews$/.test(path)) return respond(Number(parsed.searchParams.get('offset')) ? [] : [{ id: '90000000-0000-4000-8000-000000000088', display_name: 'Sam', rating: 4, title: ar ? 'طازج' : 'Fresh', body: ar ? 'جودة جيدة' : 'Good quality', created_at: '2026-10-13T00:00:00Z' }]);
    if (/^v1\/customer\/products\/[^/]+\/review$/.test(path)) {
      const id = path.split('/')[3]!;
      if (init.method === 'PUT') {
        const input = JSON.parse(init.body as string);
        const review = { ...input, id: '90000000-0000-4000-8000-000000000089', status: 'pending', version: (ownReviews.get(id)?.version ?? 0) + 1, created_at: '2026-10-13T00:00:00Z' };
        ownReviews.set(id, review);
        if (input.title === 'INTERRUPT') throw new Error('Isolated lost review response');
        return respond(review);
      }
      return respond(ownReviews.get(id) ?? null);
    }
    if (path.startsWith('v1/customer/wishlist/')) { const id = path.split('/').at(-1)!; savedIDs = savedIDs.filter(v => v !== id); if (init.method === 'PUT') savedIDs.unshift(id); return respond({ ok: true }); }
    if (path === 'v1/cart/trust/confirm') return respond({ ok: true });
    if (path.startsWith('v1/cart/shopping/')) {
      const id = tasks.get(path.split('/').at(-1)!);
      return respond({ task_revision: id ? 1 : 0, source_revision: 0, proposal_id: id ?? null, cancelled: false });
    }
    if (path === 'v1/cart/proposals' && init.method === 'POST') {
      const draft = JSON.parse(init.body as string) as ReorderDraft;
      const previous = tasks.get(draft.task_id);
      if (previous && reorders.get(previous)?.applied) return new Response('{}', { status: 409 });
      if (draft.auto_select) draft.selections = [{ product_id: variant.id, quantity: 1, replaces: null, required_attributes: {}, reason: 'Reorder' }];
      const id = `90000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`;
      const quantity = (cart.items[0]?.quantity ?? 0) + draft.selections.reduce((n, s) => n + s.quantity, 0);
      const proposal: ReorderProposal = { id, draft, applied: false, can_apply: true, expires_at: new Date(Date.now() + 900000).toISOString(), execution: { verdict: 'pass' }, issues: [], notes: [], current_items: cart.items, resulting_items: [{ ...fixture.cart.items[0]!, name: variant.name, quantity, line_total: (25 * quantity).toFixed(2), currency: 'EGP' }], after: { payable: (25 * quantity + 5).toFixed(2), currency: 'EGP' }, lines: draft.selections.map(selection => ({ selection, product: variant, historical_price: '25.00', available: 100 })) };
      reorders.set(id, proposal); tasks.set(draft.task_id, id); return respond(proposal);
    }
    const reorder = reorders.get(path.split('/')[3]!);
    if (reorder && path.startsWith('v1/cart/proposals/')) {
      if (path.endsWith('/apply') && !reorder.applied) {
        reorder.applied = true;
        cart = { ...cart, items: reorder.resulting_items.map(i => ({ ...fixture.cart.items[0]!, ...i })), subtotal: (Number(reorder.after.payable) - 5).toFixed(2) };
      }
      return respond(path.endsWith('/apply') ? cart : reorder);
    }
    if (path.endsWith('/apply')) { proposalApplied = true; return respond(cart); }
    if (path.startsWith('v1/cart/proposals/')) return respond({ draft: { goal: { purpose: ar ? 'أساسيات طازجة للأسبوع' : 'Fresh essentials for the week' }, mode: 'add' }, current_items: cart.items, resulting_items: cart.items, after: { subtotal: '25.00', discount: '0.00', tax: '0.00', delivery: '5.00', payable: '30.00', currency: 'EGP' }, issues: [], notes: [], expires_at: new Date(Date.now() + 900000).toISOString(), can_apply: true, applied: proposalApplied, execution: { verdict: 'pass' } });
    if (path === 'v1/assistant/chat') {
      const input = JSON.parse(init.body as string), question = input.message.toLowerCase();
      const recommended = { id: variant.id, name: variant.name, price: variant.price, currency: variant.currency, image_id: null, in_stock: true, route: `/products/${variant.id}`, reasons: [ar ? 'اختيار طازج لاحتياجاتك اليومية.' : 'A fresh choice for everyday essentials.'], unmet: [], attributes: [{ name: ar ? 'الحجم' : 'Size', value: '1 kg' }] };
      const events: Record<string, unknown>[] = [{ type: 'progress', stage: 'catalog' }, { type: 'message.delta', text: ar ? 'إليك اقتراحاً من المتجر.' : 'Here is a recommendation from the store.' }];
      if (question.includes('proposal')) events.push({ type: 'content.blocks', blocks: [{ kind: 'basket_proposal', proposal_id: '80000000-0000-4000-8000-000000000099' }] });
      else if (question.includes('clarify')) events.push({ type: 'message.delta', text: ' What would you prefer?', clarification: { original_message: input.message, question: ar ? 'ماذا تفضّل؟' : 'What would you prefer?', choices: ['Fruit', 'Bread'] } });
      else events.push({ type: 'content.blocks', blocks: [{ kind: 'recommendation_group', title: ar ? 'اختيارنا لك' : 'Picked for you', products: [recommended], sources: [{ kind: 'catalog', product_id: recommended.id, route: recommended.route }] }] });
      if (!question.includes('interrupt')) events.push({ type: 'done', saved: true });
      const encoded = new TextEncoder().encode(events.map((e, sequence) => `data: ${JSON.stringify({ version: '1', request_id: input.request_id, sequence, ...e })}\n\n`).join(''));
      // Real incremental framing through the same parser, without native fetch or a server.
      let position = 0;
      const body = new ReadableStream<Uint8Array>({ async pull(controller) { await new Promise(resolve => setTimeout(resolve, question.includes('slow') ? 200 : 15)); if (init.signal?.aborted) { controller.error(new Error('Stopped')); return; } if (position >= encoded.length) { controller.close(); return; } controller.enqueue(encoded.slice(position, position + 160)); position += 160; } });
      const result = new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } });
      Object.defineProperty(result, 'body', { value: body }); return result;
    }
    if (path === 'v1/customer/auth/refresh' || path === 'v1/customer/auth/login') return respond({ ...fixture.auth, customer }, true);
    if (path.startsWith('v1/customer/auth/')) return respond({});
    if (path === 'v1/customer/me') return respond(customer);
    if (path === 'v1/catalog/categories') return respond(fixture.categories.map(c => ({ ...c, name: ar ? 'الفاكهة' : 'Fresh fruit' })));
    if (path === 'v1/search') return respond({ hits: parsed.searchParams.get('q') === 'missing' ? [] : [product], total: 1 });
    if (path.endsWith('/family')) return respond({ children: [variant] });
    if (path === 'v1/catalog/relationships') return respond(parsed.searchParams.get('sources')?.includes(variant.id) ? [product] : [variant]);
    if (path === `v1/catalog/products/${product.id}`) return respond(product);
    if (path === `v1/catalog/products/${variant.id}`) return respond(variant);
    if (path === 'v1/delivery-area') return respond({ configured: true, deliverable: true });
    if (path === 'v1/customer/locations') return respond(init.method === 'POST' ? { ...fixture.location, ...JSON.parse(init.body as string) } : fixture.locations.map(l => ({ ...l, formatted_address: ar ? '١٢ شارع الحديقة، القاهرة' : '12 Garden Street, Cairo' })));
    if (path === 'v1/cart/coupon' && init.method === 'PUT') {
      const code = JSON.parse(init.body as string).code;
      if (code === 'OFFLINE') throw new Error('Isolated network failure');
      cart = { ...cart, coupon_code: code || null, coupon_error: code && code !== 'SAVE5' ? (ar ? 'هذا الكود غير صالح' : 'This code is not valid') : null, discount_amount: code === 'SAVE5' ? '5.00' : '0.00' };
      return respond(cart);
    }
    if (path === 'v1/cart/items' || path.startsWith('v1/cart/items/')) {
      const quantity = init.method === 'DELETE' ? 0 : JSON.parse(init.body as string).quantity;
      cart = { ...cart, items: quantity ? [{ ...fixture.cart.items[0]!, quantity, reserved_quantity: quantity, line_total: (25 * quantity).toFixed(2) }] : [], subtotal: (25 * quantity).toFixed(2) };
    }
    if (path === 'v1/cart' || path.startsWith('v1/cart/items')) return respond({ ...cart, items: cart.items.map(i => ({ ...i, name: variant.name })) });
    if (path === 'v1/fulfillment/availability') return respond(fixture.availability);
    if (path === 'v1/fulfillment/plan-options') return respond(fixture.options);
    if (path === 'v1/fulfillment/plans') return respond(fixture.plan);
    if (path === 'v1/customer/checkout/quote') return respond({ ...fixture.quote, expires_at: new Date(Date.now() + 900000).toISOString(), snapshot: { ...fixture.quote.snapshot, gift_message: JSON.parse(init.body as string).gift_message ?? null, subtotal: cart.subtotal, discount_amount: cart.discount_amount ?? '0.00', total: (Number(cart.subtotal) - Number(cart.discount_amount ?? 0) + Number(fixture.quote.snapshot.delivery_fee) + Number(fixture.quote.snapshot.tax_amount)).toFixed(2) } });
    if (path === 'v1/customer/checkout/place') { cart = fixture.empty_cart; return respond(fixture.detail); }
    if (path === 'v1/customer/orders') return respond(scenario === 'Empty' || Number(parsed.searchParams.get('offset')) > 0 ? [] : [fixture.order]);
    if (path === `v1/customer/orders/${fixture.order.id}`) return respond({ ...fixture.detail, order: { ...fixture.order, gift_message: ar ? 'هدية سعيدة' : 'Happy birthday', subtotal: '25.00', discount_amount: '2.00', delivery_fee: '5.00', tax_amount: '0.00', total: '28.00' }, items: [{ ...fixture.cart.items[0]!, unit: 'kg', discount_amount: '2.00' }] });
    throw new Error(`Visual preview has no route: ${path}`);
  };
  return { identity: merchant, commerce: new CommerceClient(transport, { get: async key => memory.get(key) ?? null, set: async (key, value) => { if (value === null) memory.delete(key); else memory.set(key, value); } }, () => `80000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`) };
}
export default function VisualPreview() {
  const [scenario, setScenario] = useState<Scenario>('Guest');
  const config = useMemo(() => configuration(scenario), [scenario]);
  return <View style={{ flex: 1 }}>
    <View style={{ paddingTop: 56, paddingHorizontal: 8, backgroundColor: '#FFF4D6' }}>
      <Text style={{ fontSize: 10, textAlign: 'center' }}>VISUAL QA · ISOLATED FIXTURES · NO LIVE ORDERS</Text>
      <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>{(['Guest', 'Customer', 'Empty', 'Unverified'] as const).map(value => <Pressable key={value} accessibilityRole="button" onPress={() => setScenario(value)} style={{ padding: 10 }}><Text style={{ fontWeight: value === scenario ? '700' : '400', fontSize: 12 }}>{value}</Text></Pressable>)}</View>
    </View>
    <SafeAreaProvider><LiveStorefront key={scenario} configuration={config} /></SafeAreaProvider>
  </View>;
}
