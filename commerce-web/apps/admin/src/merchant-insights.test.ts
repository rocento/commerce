import { expect, it } from 'vitest';
import type { MerchantAnswer } from '@commerce/api-client';
import { merchantInsight } from './merchant-insights';
const base: MerchantAnswer = {request_id:'00000000-0000-0000-0000-000000000001',conversation_id:'00000000-0000-0000-0000-000000000001',helpful:null,question:'orders',title:'Orders',from:'2026-09-01',to:'2026-09-28',currency:'USD',scope:'installation',evaluated_at:'2026-09-28T00:00:00Z',columns:[],rows:[],notes:[],truncated:false};
it('keeps large order counts exact and separates statuses from revenue', () => {
 const result = merchantInsight({...base,columns:['Status','Orders','Order value','Recorded refunds','Value less refunds'],rows:[['cancelled','9007199254740993','1','0','1'],['delivered','2','20','0','20']]});
 expect(result.summary).toContain('9007199254740995 orders');
 expect(result.summary).toContain('cancelled');
 expect(result.caveat).toContain('not collected revenue');
});
it('preserves precise monetary strings and explains ordered-unit ranking', () => {
 const result = merchantInsight({...base,question:'top_sellers',columns:['Product ID','Product at order time','Units','Merchandise value'],rows:[['id','Tea','12','9007199254740993.01']]});
 expect(result.summary).toContain('9007199254740993.01 USD');
 expect(result.caveat).toContain('unfulfilled orders');
});
it('does not extrapolate truncated rows or invent causal explanations', () => {
 const result = merchantInsight({...base,question:'category_decline',truncated:true,columns:['Category ID','Current category','Previous value','Current value','Change'],rows:[['id','Tea','20','10','-10']]});
 expect(result.summary).toContain('At least 1');
 expect(result.caveat).toContain('does not establish why');
});
it('handles missing data and incompatible column layouts without inventing facts', () => {
 expect(merchantInsight(base).summary).toContain('No matching records');
 expect(merchantInsight({...base,rows:[['x']],columns:['Unexpected']}).summary).toContain('records are shown below');
});
it('explains current stock and exact order status', () => {
 expect(merchantInsight({...base,question:'low_stock',columns:['Product ID','Product','SKU','On hand','Reserved','Available'],rows:[['id','Tea','T','1','2','-1']]}).summary).toContain('-1 units');
 expect(merchantInsight({...base,question:'order_status',columns:['Order ID','Order number','Status','Created UTC','Order value','Recorded refunds'],rows:[['id','7','cash_collected','date','25.50','2.00']]}).summary).toContain('Order #7 is cash collected');
});
