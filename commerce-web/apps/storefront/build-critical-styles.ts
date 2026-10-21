import type { Plugin } from 'vite';

/** The SPA needs its initial styles before React paints; avoid two CSS round trips. */
export function criticalStorefrontStyles(): Plugin {
  return {
    name: 'storefront-critical-styles',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        if (!context.bundle || !context.filename.endsWith('/index.html')) return;
        return html.replace(/<link\b[^>]*rel="stylesheet"[^>]*>/g, link => {
          const href = /href="([^"]+)"/.exec(link)?.[1];
          const asset = href && context.bundle[href.replace(/^\//, '')];
          if (!asset || asset.type !== 'asset' || typeof asset.source !== 'string') {
            throw new Error(`Missing initial storefront stylesheet: ${href}`);
          }
          // Generated CSS URLs are absolute, so fonts/images keep their asset URLs.
          const css = asset.source.replace(/<\/style/gi, '<\\/style');
          return `<style data-storefront-styles="${asset.fileName}">${css}</style>`;
        });
      },
    },
  };
}
