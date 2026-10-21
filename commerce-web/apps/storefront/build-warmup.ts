import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

export function homeThemeWarmup(): Plugin {
  const source = readFileSync(new URL('./src/early-theme.js', import.meta.url), 'utf8');
  let channel = 'storefront';
  return {
    configResolved(config) { channel = config.env.VITE_SALES_CHANNEL || 'storefront'; },
    name: 'storefront-home-theme-warmup',
    transformIndexHtml: {
      order: 'post',
      handler(_html, context) {
        if (!context.filename.endsWith('/index.html')) return;
        const asset = (name: string) => {
          if (!context.bundle) return `/src/${name}.webp`;
          const file = Object.keys(context.bundle).find(file => file.startsWith(`assets/${name}-`) && file.endsWith('.webp'));
          if (!file) throw new Error(`Missing homepage image: ${name}`);
          return `/${file}`;
        };
        const original = context.bundle
          ? Object.keys(context.bundle).find(file => /^assets\/theme-default-(?!480-|800-).+\.webp$/.test(file))
          : undefined;
        if (context.bundle && !original) throw new Error('Missing original homepage image');
        const fallback = {
          src: asset('theme-default-800'),
          srcSet: `${asset('theme-default-480')} 480w, ${asset('theme-default-800')} 800w, ${original ? `/${original}` : '/src/theme-default.webp'} 1254w`,
          sizes: '(max-width: 540px) calc(100vw - 32px), 50vw',
        };
        const literal = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c');
        const warmup = source.replace('__WARMUP_CHANNEL__', literal(channel)).replace('__WARMUP_DEFAULT_HERO__', literal(fallback));
        // Discover the entry before running the theme warmup. Keep the original
        // module script so execution stays deferred until the document is parsed.
        const entry = /<script\b[^>]*type="module"[^>]*src="([^"]+)"[^>]*>/i.exec(_html)?.[1];
        if (context.bundle && !entry) throw new Error('Missing storefront entry module');
        const preload = context.bundle && entry
          ? `<link rel="modulepreload" crossorigin fetchpriority="high" href="${entry}"/>`
          : '';
        // Encoding must remain in the first 1024 bytes, ahead of all warmup code.
        return _html.replace(/<meta\s+charset=[^>]+>/i, charset => `${charset}${preload}<script id="storefront-theme-warmup">${warmup}</script>`);
      },
    },
  };
}
