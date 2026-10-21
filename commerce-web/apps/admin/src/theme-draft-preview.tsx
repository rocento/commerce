import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, themeApi, validateTheme } from '@commerce/api-client';
import { Notice } from '@commerce/ui';

export function ThemeDraftPreview({ id, revision, name, device, locale = '' }: { id: string; revision: number; name: string; device: string; locale?: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [channel] = useState(() => crypto.randomUUID());
  const target = useMemo(() => {
    try {
      const url = new URL(import.meta.env.VITE_STOREFRONT_URL || `${window.location.protocol}//${window.location.hostname}:5173`);
      if (!['http:', 'https:'].includes(url.protocol)) return null;
      url.searchParams.set('theme_preview', id);
      if (locale) url.searchParams.set('lang', locale);
      url.searchParams.set('revision', String(revision));
      // This channel is scoped to one iframe. No admin cookie or token is shared.
      url.searchParams.set('preview_parent', window.location.origin);
      url.searchParams.set('preview_channel', channel);
      return url;
    } catch { return null; }
  }, [id, revision, channel, locale]);
  const draft = useQuery({ queryKey: ['theme-authorized-preview', id, revision], queryFn: async () => {
    const configuration = await themeApi.preview(id);
    if (validateTheme(configuration).length) throw new Error('The draft configuration is invalid. Validate and save the theme before previewing.');
    return configuration;
  }, staleTime: 0, gcTime: 0, retry: false });
  useEffect(() => {
    if (!target || !draft.data) return;
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== target.origin || event.data?.type !== 'rocento:theme-preview-ready' || event.data?.channel !== channel || event.data?.themeId !== id) return;
      frame.current.contentWindow?.postMessage({ type: 'rocento:theme-preview-config', channel, themeId: id, configuration: draft.data }, target.origin);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [target, draft.data, channel, id]);
  if (!target) return <Notice error>The storefront preview address is invalid. Check the storefront URL setting.</Notice>;
  if (draft.isPending) return <p role="status">Loading draft preview…</p>;
  if (draft.error) return <div><Notice error>{draft.error instanceof ApiError && draft.error.status === 401 ? 'Your admin session has expired. Sign in again to preview this draft.' : draft.error instanceof ApiError && draft.error.status === 403 ? 'Your admin role does not have permission to preview this theme.' : draft.error.message}</Notice><button className="secondary" onClick={() => void draft.refetch()}>Retry preview</button></div>;
  return <iframe ref={frame} data-device={device} className="theme-live-preview" title={`${name} draft preview`} src={target.href} onLoad={() => { if (draft.data) frame.current?.contentWindow?.postMessage({ type: "rocento:theme-preview-config", channel, themeId: id, configuration: draft.data }, target.origin); }} />;
}
