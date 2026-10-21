import http from 'node:http';
import https from 'node:https';
// Explicit Host is required for the private, fixed-address gateway. No browser credentials.
export function gatewayFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = (target.protocol === 'https:' ? https : http).request(target, { method: options.method || 'GET', headers: options.headers, signal: options.signal }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 4 * 1024 * 1024) response.destroy(new Error('Publication response too large')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => resolve(new Response(options.method === 'HEAD' || [204,304].includes(response.statusCode) ? null : Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
    });
    request.setTimeout(5000, () => request.destroy(new Error('Gateway timeout')));
    request.on('error', reject);request.end();
  });
}
