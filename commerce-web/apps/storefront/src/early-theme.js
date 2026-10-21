// Runs before the application bundle. Only warm the ordinary anonymous home
// theme; the application still validates it and resolves authenticated targeting.
(() => {
  try {
    const params = new URLSearchParams(location.search);
    if (location.pathname !== '/' || params.has('theme_preview') || params.has('interface_preview')) return;
    if (sessionStorage.getItem('commerce-theme-city')) return;
    // The anonymous warmup cannot be reused once a shopper has a delivery draft.
    // Let the application resolve that context once instead of downloading its hero twice.
    if (sessionStorage.getItem('commerce-guest-location')) return;
    const channel = __WARMUP_CHANNEL__;
    const fallback = __WARMUP_DEFAULT_HERO__;
    const url = `/api/v1/theme/${encodeURIComponent(channel)}`;
    // Explicitly discover the critical theme without an extra round trip. The
    // fetch below consumes this credentialed preload; targeted contexts bypass it.
    const preload = document.createElement('link');
    preload.rel = 'preload'; preload.as = 'fetch'; preload.crossOrigin = 'use-credentials';
    preload.href = url; preload.fetchPriority = 'high';
    document.head.append(preload);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const promise = fetch(url, {
      credentials: 'include', cache: 'no-cache', priority: 'high', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Commerce-Request': '1', 'x-delivery-context': '1' },
    }).then(response => response.ok ? response.json() : null).then(result => {
      const theme = result?.configuration;
      if (!theme || theme.schema_version !== 'theme/v1' || !Array.isArray(theme.global?.top) || !Array.isArray(theme.pages?.home)) return null;
      const hero = [...theme.global.top, ...theme.pages.home].find(section => section.enabled && ['hero', 'editorial_hero'].includes(section.component));
      const id = hero?.settings?.image;
      const defaultImage = hero?.component === 'hero' && !id;
      if (defaultImage || (typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id))) {
        const image = document.createElement('link');
        image.rel = 'preload'; image.as = 'image'; image.fetchPriority = 'high';
        image.href = id ? `/api/v1/catalog/media/${id}/content` : fallback.src;
        const presentation = theme.global.top.find(section => section.enabled && section.component === 'presentation')?.settings?.style;
        const grocery = !['heritage', 'showcase', 'editorial'].includes(presentation);
        if (defaultImage) {
          image.imageSrcset = fallback.srcSet;
          image.imageSizes = grocery ? fallback.sizes : '100vw';
        } else {
          const metadata = result.images?.[id];
          if (metadata?.id === id && metadata.width > 0 && metadata.height > 0 && Array.isArray(metadata.variants)) {
            const variants = [...new Map(metadata.variants.filter(variant => ([480, 960].includes(variant.width) || variant.width === metadata.width) && variant.width <= metadata.width && variant.height > 0).map(variant => [variant.width, variant])).values()].sort((a, b) => a.width - b.width);
            if (variants.length) {
              const base = image.href;
              const fullSize = variants.some(variant => variant.width === metadata.width);
              if (fullSize) image.href = `${base}?width=${metadata.width}`;
              image.imageSrcset = [...variants.map(variant => `${base}?width=${variant.width} ${variant.width}w`), ...(!fullSize ? [`${base} ${metadata.width}w`] : [])].join(', ');
              image.imageSizes = hero.component === 'hero' ? (grocery ? fallback.sizes : '100vw') : presentation === 'heritage' ? '100vw' : '(max-width: 640px) 100vw, 50vw';
            }
          }
        }
        document.head.append(image);
      }
      return result;
    }).catch(() => null).finally(() => clearTimeout(timeout));
    window.__storefrontThemeWarmup = { channel, started: Date.now(), promise };
  } catch { /* Storage restrictions or unsupported APIs must not block startup. */ }
})();
