import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';
import type { Plugin } from 'vite';

// Compress final on-disk output after Vite has replaced preload placeholders.
// Earlier Rollup hooks can still contain code that Vite rewrites afterwards.
export function compressedAssets(): Plugin {
  let serverBuild = false;
  return {
    name: 'storefront-compressed-assets',
    apply: 'build',
    configResolved(config) { serverBuild = !!config.build.ssr; },
    async writeBundle(options, bundle) {
      if (serverBuild) return;
      await Promise.all(Object.keys(bundle).filter(name =>
        (name.startsWith('assets/') && /\.(js|css)$/.test(name)) || /^(index|public)\.html$/.test(name),
      ).map(async name => {
        const file = resolve(options.dir || 'dist', name);
        const bytes = await readFile(file);
        await Promise.all([
          writeFile(`${file}.br`, brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } })),
          writeFile(`${file}.gz`, gzipSync(bytes, { level: 9 })),
        ]);
      }));
    },
  };
}
