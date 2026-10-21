import type { ResolvedTheme } from '@commerce/api-client';
type Warmup = { channel: string; started: number; promise: Promise<ResolvedTheme | null> };
declare global { interface Window { __storefrontThemeWarmup?: Warmup } }

export function takeThemeWarmup(channel: string, city: string, delivery: string, authenticated: boolean): Promise<ResolvedTheme | null> | undefined {
  const warmup = window.__storefrontThemeWarmup;
  delete window.__storefrontThemeWarmup;
  if (!warmup || warmup.channel !== channel || city || delivery !== 'none' || authenticated || Date.now() - warmup.started > 10_000) return;
  return warmup.promise;
}
