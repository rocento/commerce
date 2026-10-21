import { createGzip } from 'node:zlib';

export function acceptedEncodings(header = '') {
  const weights = new Map(String(header).toLowerCase().split(',').map(part => {
    const [name, ...parameters] = part.trim().split(';');
    const quality = parameters.find(value => value.trim().startsWith('q='));
    const q = quality ? Number(quality.trim().slice(2)) : 1;
    return [name, Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0];
  }));
  return ['br', 'gzip'].map(name => ({ name, q: weights.get(name) ?? weights.get('*') ?? 0 }))
    .filter(({ q }) => q > 0).sort((a, b) => b.q - a.q).map(({ name }) => name);
}

export function sendBody(req, res, body, type) {
  const compressible = /^(text\/|application\/(json|javascript|xml|manifest\+json))/.test(type);
  if (compressible) res.setHeader('Vary', 'Accept-Encoding');
  if (!res.hasHeader('Content-Encoding') && compressible && Buffer.byteLength(body) >= 1024 && acceptedEncodings(req.headers['accept-encoding']).includes('gzip')) {
    res.setHeader('Content-Encoding', 'gzip');
    if (req.method === 'HEAD') return res.end();
    const stream = createGzip({ level: 6 });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
    return stream.end(body);
  }
  res.end(req.method === 'HEAD' ? undefined : body);
}
