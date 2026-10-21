import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { AssistantOrderGuide } from './assistant-order-guide';
const state = vi.hoisted(() => ({ items: [{product_id:'one',name:'Apples',quantity:2}] as {product_id:string;name:string;quantity:number}[] }));
vi.mock('./cart', () => ({useCart: () => ({cart:{items:state.items},ready:true,syncing:false,setCart:vi.fn()})}));
vi.mock('./locations', () => ({useDeliveryKey: () => 'none'}));
vi.mock('@tanstack/react-query', () => ({useQueries: () => []}));
const render = () => renderToStaticMarkup(<AssistantOrderGuide prompts={[{query:'bananas',quantity:2,action:'cart'}]} busy={false} onChoose={vi.fn()} onCompare={vi.fn()} />);
it('asks for a cart decision before displaying the order builder', () => {
 state.items = [{product_id:'one',name:'Apples',quantity:2}];
 const html = render();
 expect(html).toContain('Keep current cart and add products');
 expect(html).toContain('Clear cart and start this order');
 expect(html).not.toContain('Let’s build your order');
 expect(html).not.toContain('Find products');
});
it('opens the builder directly for an empty cart', () => {
 state.items = [];
 expect(render()).toContain('Let’s build your order');
 expect(render()).not.toContain('Keep current cart and add products');
});
