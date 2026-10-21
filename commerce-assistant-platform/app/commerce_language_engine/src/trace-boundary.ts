import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
// Private versioned context; identifiers only. Not a W3C traceparent contract.
export function traceBoundary(header: string|string[]|undefined) {
 if(typeof header!=='string'||header.length>160||!/^1\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[a-zA-Z0-9-]{1,64}$/.test(header))return null;
 const started=performance.now(),id=randomUUID();
 return ()=>`${header}/${id}/${(performance.now()-started).toFixed(3)}`;
}
