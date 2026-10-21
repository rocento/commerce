import { afterEach, expect, it, vi } from 'vitest';
import { saveAssistantDeliveryEvent } from './assistant';
vi.mock('./identity', () => ({assistantHeaders: () => ({'Content-Type':'application/json'}),ApiError:class extends Error {}}));
afterEach(() => vi.unstubAllGlobals());
it('sends only event identifiers and waits for persistence acknowledgment', async () => {
 const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({saved:true})));
 vi.stubGlobal('fetch',fetcher);
 await saveAssistantDeliveryEvent('conversation','request','location');
 expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({conversation_id:'conversation',request_id:'request',location_id:'location'});
 expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
});
it.each([503,200])('does not accept a failed persistence response (%s)', async status => {
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({saved:false}),{status})));
 await expect(saveAssistantDeliveryEvent('c','r','l')).rejects.toThrow('could not be saved');
});
