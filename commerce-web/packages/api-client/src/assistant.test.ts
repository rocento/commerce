import { describe, expect, it, vi } from "vitest";
import { parseAssistantEvent, streamAssistant } from "./assistant";
import { ApiError } from "./identity";
const id = "12345678-1234-1234-1234-123456789abc";
const event = {version:"1",request_id:id,sequence:0,type:"message.delta",text:"Hello"};
it("negotiates and validates pre-stream HTTP recovery without exposing raw bodies", async () => {
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  const failure = { code: "authentication_needed", message: "Please sign in again.", retryable: false, recovery: "sign_in", request_reference: id };
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: "secret-canary", failure }), { status: 401 })).mockResolvedValueOnce(new Response(JSON.stringify({ error: "secret-canary", failure: { ...failure, request_reference: "00000000-0000-0000-0000-000000000000" } }), { status: 401 }));
  vi.stubGlobal("fetch", fetcher);
  try {
    const call = () => streamAssistant({ request_id: id, message: "Hello" }, () => {}, new AbortController().signal);
    await expect(call()).rejects.toMatchObject({ status: 401, failure });
    expect(fetcher.mock.calls[0][1].headers["X-Commerce-Request-Reference"]).toBe(id);
    const error = await call().then(() => { throw new Error("Expected HTTP failure"); }, e => e as ApiError);
    expect(error.failure).toBeUndefined();
    expect(error.message).not.toContain("secret-canary");
  } finally { vi.unstubAllGlobals(); }
});
describe("untrusted assistant stream", () => {
  it("accepts the shared contract", () => expect(parseAssistantEvent(JSON.stringify(event),id,0).text).toBe("Hello"));
  it.each([{...event,url:"http://evil.test"},{...event,sequence:3},{...event,request_id:"bad"},{...event,type:"execute"},{...event,text:{html:"<script>"}},{...event,type:"card.order",order:{id:"javascript:alert(1)"}}])("rejects malformed envelopes", value => expect(() => parseAssistantEvent(JSON.stringify(value),id,0)).toThrow());
});

import { setDeliveryPin } from "./delivery";
it("passes the selected delivery pin outside model input", async () => {
  vi.stubGlobal("window", {dispatchEvent:vi.fn()});
  const fetcher = vi.fn().mockResolvedValue(new Response(`data: ${JSON.stringify({version:"1",request_id:id,sequence:0,type:"done"})}\n\n`, {headers:{"content-type":"text/event-stream"}}));
  vi.stubGlobal("fetch",fetcher);
  try {
    setDeliveryPin({latitude:30,longitude:31});
    await streamAssistant({request_id:id,message:"Find fruit"},()=>{},new AbortController().signal);
    expect(fetcher.mock.calls[0][1].headers).toMatchObject({"x-delivery-latitude":"30","x-delivery-longitude":"31"});
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({request_id:id,message:"Find fruit"});
  } finally {setDeliveryPin(null);vi.unstubAllGlobals();}
});

import { parseAssistantHistory } from "./assistant";
it("accepts only typed high-level progress, never raw tool payloads", () => {
  const progress = { version: "1", request_id: id, sequence: 0, type: "progress", stage: "catalog" };
  expect(parseAssistantEvent(JSON.stringify(progress), id, 0).stage).toBe("catalog");
  for (const invalid of [{ ...progress, stage: "raw_sql" }, { ...progress, text: "secret" }, { ...progress, arguments: {} }, { ...progress, stage: undefined }]) expect(() => parseAssistantEvent(JSON.stringify(invalid), id, 0)).toThrow();
});
it("validates bounded history before rendering", () => {
  const turn = { conversation_id: id, request_id: id, question: "Question", answer: "Answer", created_at: "2026-09-15T12:00:00Z" };
  expect(parseAssistantHistory([turn])).toEqual([turn]);
  for (const bad of [null, [{ ...turn, answer: {} }], Array(101).fill(turn), [{ ...turn, raw_tool: "secret" }]]) expect(() => parseAssistantHistory(bad)).toThrow();
});
it("assembles fragmented SSE progress and text and rejects missing completion", async () => {
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  const frames = [{ version: "1", request_id: id, sequence: 0, type: "progress", stage: "catalog" }, { ...event, sequence: 1 }, { version: "1", request_id: id, sequence: 2, type: "done" }];
  const response = (complete: boolean) => new Response(new ReadableStream({ start(controller) {
    const bytes = new TextEncoder().encode(frames.slice(0, complete ? 3 : 2).map(f => `data: ${JSON.stringify(f)}\n\n`).join(""));
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(true)).mockResolvedValueOnce(response(false)));
  try {
    const seen: string[] = [];
    await streamAssistant({ request_id: id, message: "Find" }, e => seen.push(e.type), new AbortController().signal);
    expect(seen).toEqual(["progress", "message.delta", "done"]);
    await expect(streamAssistant({ request_id: id, message: "Find" }, () => {}, new AbortController().signal)).rejects.toThrow("interrupted");
  } finally { vi.unstubAllGlobals(); }
});

const richProduct = { id, name: "Shoes", image_id: null, price: "99", currency: "USD", in_stock: null, route: `/products/${id}`, attributes: [], reasons: ["Current catalog price: 99 USD"], unmet: [] };
const richBlock = { kind: "product_card", title: "Details", products: [richProduct], sources: [{ kind: "catalog", product_id: id, route: richProduct.route }] };
it("validates nullable catalog facts and rejects malformed rich structures", () => {
  const frame = (blocks: unknown) => JSON.stringify({ version: "1", request_id: id, sequence: 0, type: "content.blocks", blocks });
  expect(parseAssistantEvent(frame([richBlock]), id, 0).blocks?.[0].products?.[0].in_stock).toBeNull();
  const invalid = [
    { ...richBlock, html: "<script>" }, { ...richBlock, text: "extra" },
    { ...richBlock, kind: "execute" }, { ...richBlock, products: [] },
    { ...richBlock, products: [{ ...richProduct, route: "javascript:alert(1)" }] },
    { ...richBlock, products: [{ ...richProduct, price: "free" }] },
    { ...richBlock, products: [{ ...richProduct, image_id: "https://evil.test/pixel" }] },
    { ...richBlock, sources: [] },
    { ...richBlock, sources: [{ ...richBlock.sources[0], product_id: "00000000-0000-0000-0000-000000000000" }] },
    { ...richBlock, kind: "comparison_table", rows: [{ label: "Size", values: ["42", "Not provided"] }] },
    { kind: "action", action: { label: "Buy", route: "/api/admin/delete" } },
  ];
  for (const bad of invalid) expect(() => parseAssistantEvent(frame([bad]), id, 0)).toThrow();
  expect(() => parseAssistantEvent(frame([]), id, 0)).toThrow();
  expect(() => parseAssistantEvent(JSON.stringify({ ...event, blocks: [richBlock] }), id, 0)).toThrow();
});
it("rejects repeated rich payloads in one response", async () => {
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  const frames = [0, 1].map(sequence => ({ version: "1", request_id: id, sequence, type: "content.blocks", blocks: [richBlock] }));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })));
  try { await expect(streamAssistant({ request_id: id, message: "Show" }, () => {}, new AbortController().signal)).rejects.toThrow("repeated"); }
  finally { vi.unstubAllGlobals(); }
});
it("accepts one rich product block after the wishlist text event", async () => {
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  const frames = [
    { version: "1", request_id: id, sequence: 0, type: "progress", stage: "preparing" },
    { version: "1", request_id: id, sequence: 1, type: "message.delta", text: "You have 6 saved items. Here are up to three:", response_source: "R" },
    { version: "1", request_id: id, sequence: 2, type: "content.blocks", blocks: [richBlock], response_source: "R" },
    { version: "1", request_id: id, sequence: 3, type: "done" },
  ];
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })));
  try {
    const seen: string[] = [];
    await streamAssistant({ request_id: id, message: "View my wishlist" }, event => seen.push(event.type), new AbortController().signal);
    expect(seen).toEqual(["progress", "message.delta", "content.blocks", "done"]);
  } finally { vi.unstubAllGlobals(); }
});
it("restores validated typed blocks and feedback in saved history", () => {
  const turn = {conversation_id:id,request_id:id,question:'Find shoes',answer:'Saved facts',created_at:'2026-09-15T00:00:00Z',blocks:[richBlock],helpful:true};
  expect(parseAssistantHistory([turn])[0].blocks?.[0].products?.[0].price).toBe('99');
  expect(() => parseAssistantHistory([{...turn,blocks:[{...richBlock,products:[]}]}])).toThrow();
  expect(() => parseAssistantEvent(JSON.stringify({...event,saved:true}),id,0)).toThrow();
});

const cartBlock = { kind: "cart_summary", cart: { items: [{ product_id: id, name: "Tea", quantity: 2, price: "3.00", line_total: "6.00", currency: "USD" }], total_lines: 1, total_quantity: 2, subtotal: "6.00", discount_amount: "0", currency: "USD", fully_reserved: false } };
const removalBlock = { kind: "cart_removal", cart_removal: { product_id: id, name: "Tea", quantity: 2, remaining_quantity: 0, cart_quantity: 3, cart_subtotal: "7.50", currency: "USD" } };
const removalChoice = { kind: "cart_removal_choice", cart_removal_choice: { quantity: null, items: cartBlock.cart.items } };
it.each([removalBlock, removalChoice])("preserves removal results in streaming responses and saved chat history", block => {
  const frame = JSON.stringify({ version: "1", request_id: id, sequence: 0, type: "content.blocks", blocks: [block] });
  expect(parseAssistantEvent(frame, id, 0).blocks).toEqual([block]);
  const turn = { conversation_id: id, request_id: id, question: "Remove tea", answer: "Removed tea", created_at: "2026-09-29T00:00:00Z", blocks: [block] };
  expect(parseAssistantHistory([turn])[0].blocks).toEqual([block]);
});
it("rejects mixed removal blocks, invalid quantities and duplicate cart choices", () => {
  const invalid = [
    { ...removalBlock, cart: cartBlock.cart },
    { ...removalBlock, cart_removal: { ...removalBlock.cart_removal, quantity: 0 } },
    { ...removalBlock, cart_removal: { ...removalBlock.cart_removal, quantity: 1.5 } },
    { ...removalBlock, cart_removal: { ...removalBlock.cart_removal, remaining_quantity: -1 } },
    { ...removalBlock, cart_removal: { ...removalBlock.cart_removal, remaining_quantity: 4 } },
    { ...removalChoice, cart_removal_choice: { ...removalChoice.cart_removal_choice, items: [...cartBlock.cart.items, ...cartBlock.cart.items] } },
    { ...removalChoice, cart_removal_choice: { ...removalChoice.cart_removal_choice, quantity: 0 } },
  ];
  for (const block of invalid) expect(() => parseAssistantEvent(JSON.stringify({ version: "1", request_id: id, sequence: 0, type: "content.blocks", blocks: [block] }), id, 0)).toThrow();
});
it.each([cartBlock, richBlock])("accepts acknowledgment and result text before a rich response", async block => {
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  const frames = [
    { type: "progress", stage: "preparing" },
    { type: "message.delta", text: "Understood.\n\n", response_source: "R" },
    { type: "progress", stage: "catalog" },
    { type: "message.delta", text: "Here are your items.", response_source: "R" },
    { type: "content.blocks", blocks: [block], response_source: "R" },
    { type: "done", response_source: "R" },
  ].map((frame, sequence) => ({ version: "1", request_id: id, sequence, ...frame }));
  const bytes = new TextEncoder().encode(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } })));
  try {
    const seen: unknown[] = [];
    await streamAssistant({ request_id: id, message: "Show my items" }, event => seen.push(event), new AbortController().signal);
    expect(seen).toEqual(frames);
  } finally { vi.unstubAllGlobals(); }
});
it("accepts saved-address views in streams and history without embedded private data", () => {
  const block = { kind: "saved_addresses" };
  const frame = (blocks: unknown[]) => JSON.stringify({version:"1",request_id:id,sequence:0,type:"content.blocks",blocks});
  expect(parseAssistantEvent(frame([block]),id,0).blocks).toEqual([block]);
  expect(parseAssistantHistory([{conversation_id:id,request_id:id,question:"my saved adress",answer:"Here are your saved addresses.",created_at:"2026-09-21T00:00:00Z",blocks:[block]}])[0].blocks).toEqual([block]);
  expect(() => parseAssistantEvent(frame([{ ...block, text: "private address" }]),id,0)).toThrow();
  expect(() => parseAssistantEvent(frame([{ ...block, customer_id: id }]),id,0)).toThrow();
});
it("accepts cart item snapshots in streamed responses and restored history", () => {
  const frame = JSON.stringify({version:"1",request_id:id,sequence:0,type:"content.blocks",blocks:[cartBlock]});
  expect(parseAssistantEvent(frame,id,0).blocks?.[0].cart?.items[0].quantity).toBe(2);
  const turn = {conversation_id:id,request_id:id,question:'View my cart',answer:'2 items',created_at:'2026-09-19T00:00:00Z',blocks:[cartBlock]};
  expect(parseAssistantHistory([turn])[0].blocks?.[0].cart?.subtotal).toBe('6.00');
});
it("rejects cart payloads with extra fields, invalid counts or untrusted product links", () => {
  const invalid = [
    { ...cartBlock, text: "unexpected" },
    { ...cartBlock, cart: { ...cartBlock.cart, total_quantity: 1 } },
    { ...cartBlock, cart: { ...cartBlock.cart, total_quantity: 3 } },
    { ...cartBlock, cart: { ...cartBlock.cart, items: [] } },
    { ...cartBlock, cart: { ...cartBlock.cart, items: [{ ...cartBlock.cart.items[0], product_id: "javascript:alert(1)" }] } },
    { ...cartBlock, cart: { ...cartBlock.cart, items: [{ ...cartBlock.cart.items[0], route: "https://evil.test" }] } },
  ];
  for (const bad of invalid) expect(() => parseAssistantEvent(JSON.stringify({version:"1",request_id:id,sequence:0,type:"content.blocks",blocks:[bad]}),id,0)).toThrow();
});

it("validates typed error recovery and binds its reference to the request", () => {
  const failure = { code: "provider_timeout", message: "Please retry.", retryable: true, recovery: "retry", request_reference: id };
  const frame = { ...event, type: "error", failure };
  expect(parseAssistantEvent(JSON.stringify(frame), id, 0).failure?.retryable).toBe(true);
  for (const value of [
    { ...frame, failure: { ...failure, code: "raw-provider-error" } },
    { ...frame, failure: { ...failure, api_key: "canary" } },
    { ...frame, failure: { ...failure, request_reference: "12345678-1234-1234-1234-123456789abd" } },
    { ...frame, type: "message.delta" },
  ]) expect(() => parseAssistantEvent(JSON.stringify(value), id, 0)).toThrow();
});

it("accepts the explicit new-address form event", () => {
  expect(parseAssistantEvent(JSON.stringify({ ...event, code: "open_address_form" }), id, 0).code).toBe("open_address_form");
});

it.each(['R', 'L'])('accepts engine checkout handoffs from %s responses', response_source => {
  const command = {...event, code: 'open_checkout', response_source};
  expect(parseAssistantEvent(JSON.stringify(command), id, 0).code).toBe('open_checkout');
  for (const invalid of [
    {...command, type: 'done'}, {...command, response_source: undefined},
    {...command, blocks: [cartBlock]}, {...command, stage: 'catalog'}, {...command, saved: true},
  ]) expect(() => parseAssistantEvent(JSON.stringify(invalid), id, 0)).toThrow();
});

it('accepts comparison clear only as a deterministic message command', () => {
  const command = { ...event, code: 'clear_comparison', response_source: 'R' };
  expect(parseAssistantEvent(JSON.stringify(command), id, 0).code).toBe('clear_comparison');
  for (const invalid of [{...command, type:'done'}, {...command, response_source:'L'}, {...command, blocks:[cartBlock]}, {...command, stage:'catalog'}, {...command, saved:true}]) {
    expect(() => parseAssistantEvent(JSON.stringify(invalid),id,0)).toThrow();
  }
});
it('does not dispatch repeated comparison clear commands', async () => {
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  const frames = [0, 1].map(sequence => ({...event, sequence, code:'clear_comparison', response_source:'R'}));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), {headers:{'content-type':'text/event-stream'}})));
  const onEvent = vi.fn();
  try {
    await expect(streamAssistant({request_id:id,message:'clear comparison'},onEvent,new AbortController().signal)).rejects.toThrow('Repeated comparison');
    expect(onEvent).toHaveBeenCalledOnce();
  } finally { vi.unstubAllGlobals(); }
});

it('validates product guidance in streams and history without accepting extra executable fields', () => {
  const block = {kind: 'product_prompt', product_prompt: {query: 'banans', quantity: 2, action: 'choose'}};
  const frame = (value: unknown) => JSON.stringify({version: '1', request_id: id, sequence: 0, type: 'content.blocks', blocks: [value]});
  expect(parseAssistantEvent(frame(block), id, 0).blocks).toEqual([block]);
  expect(parseAssistantHistory([{conversation_id: id, request_id: id, question: 'add 2 banans', answer: 'Choose an action', created_at: '2026-09-28T00:00:00Z', blocks: [block]}])[0].blocks).toEqual([block]);
  for (const bad of [
    {...block, text: 'extra'}, {...block, product_prompt: undefined},
    ...[0, -1, 1.5, 1000001].map(quantity => ({...block, product_prompt: {...block.product_prompt, quantity}})),
    {...block, product_prompt: {...block.product_prompt, action: 'checkout'}},
    {...block, product_prompt: {...block.product_prompt, product_id: id}},
  ]) expect(() => parseAssistantEvent(frame(bad), id, 0)).toThrow();
});

it("preserves scoped clarification revisions and rejects malformed tokens", async () => {
  const clarification = { original_message: "add it to cart and also to wishlist", question: "Which product?", revision: id };
  const frame = { ...event, clarification };
  expect(parseAssistantEvent(JSON.stringify(frame), id, 0).clarification).toEqual(clarification);
  expect(() => parseAssistantEvent(JSON.stringify({ ...frame, clarification: { ...clarification, revision: "forged" } }), id, 0)).toThrow();
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  const fetcher = vi.fn().mockResolvedValue(new Response(`data: ${JSON.stringify({ version: "1", request_id: id, sequence: 0, type: "done" })}\n\n`, { headers: { "content-type": "text/event-stream" } }));
  vi.stubGlobal("fetch", fetcher);
  try {
    await streamAssistant({ request_id: id, conversation_id: id, message: "banana", clarification }, () => {}, new AbortController().signal);
    expect(JSON.parse(fetcher.mock.calls[0][1].body).clarification).toEqual(clarification);
  } finally { vi.unstubAllGlobals(); }
});

it("accepts bounded shopping choices only with a valid server revision", () => {
  const clarification = { original_message: "I need good phone", question: "What is your budget?", revision: id, kind: "shopping", choices: ["Up to 500 USD"], optional: true };
  const frame = { ...event, clarification };
  expect(parseAssistantEvent(JSON.stringify(frame), id, 0).clarification).toEqual(clarification);
  for (const bad of [
    { ...clarification, revision: undefined },
    { ...clarification, revision: "forged" },
    { ...clarification, choices: ["Same", "Same"] },
    { ...clarification, choices: Array.from({ length: 9 }, (_, i) => `Option ${i}`) },
    { ...clarification, frame: { query: "forged" } },
  ]) expect(() => parseAssistantEvent(JSON.stringify({ ...frame, clarification: bad }), id, 0)).toThrow();
});
