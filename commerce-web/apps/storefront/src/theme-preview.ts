import { validateTheme, type ThemeConfiguration } from '@commerce/api-client';

/** Accept a draft only from the parent and channel explicitly paired with this frame. */
export function receiveThemePreview(themeId: string, parentOrigin: string, channel: string, signal: AbortSignal): Promise<ThemeConfiguration> {
  return new Promise((resolve, reject) => {
    if (window.parent === window || !channel) { reject(new Error('Open this preview from the admin theme editor.')); return; }
    let origin: string;
    try {
      const url = new URL(parentOrigin);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== parentOrigin) throw new Error();
      origin = url.origin;
    } catch { reject(new Error('The preview parent address is invalid. Reopen the preview from admin.')); return; }
    const cleanup = () => { clearTimeout(timeout); window.removeEventListener('message', receive); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(new DOMException('Preview cancelled', 'AbortError')); };
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== origin || event.data?.type !== 'rocento:theme-preview-config' || event.data?.channel !== channel || event.data?.themeId !== themeId) return;
      cleanup();
      if (validateTheme(event.data.configuration).length) reject(new Error('The draft configuration is invalid. Validate the draft in admin.'));
      else resolve(event.data.configuration);
    };
    const timeout = window.setTimeout(() => { cleanup(); reject(new Error('The admin preview did not respond. Refresh the preview in the theme editor.')); }, 15000);
    window.addEventListener('message', receive);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    window.parent.postMessage({ type: 'rocento:theme-preview-ready', themeId, channel }, origin);
  });
}
