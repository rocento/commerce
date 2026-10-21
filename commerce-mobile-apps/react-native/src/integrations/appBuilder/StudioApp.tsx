import { digest, digestStringAsync, CryptoDigestAlgorithm } from 'expo-crypto';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { liveConfiguration } from '../../platform/commerce';
import { LiveStorefront } from '../../ui/LiveStorefront';
import type { StorefrontDesign } from '../../core/design';
import { designFromDraft } from './draft';

export default function StudioApp({ previewCode, previewOrigin }: { previewCode?: string; previewOrigin?: string }) {
  const [draft, setDraft] = useState<{ design: StorefrontDesign; revision: number; checksum: string }>();
  const [error, setError] = useState('Connecting to Apps Builder…');
  const tenant = liveConfiguration.identity.id;
  const valid = /^[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(previewCode || '') && /^https:\/\//.test(previewOrigin || '');
  const id = previewCode?.split('.')[0];
  const token = previewCode?.split('.')[1];
  const url = `${previewOrigin}/v1/mobile/preview/${id}?merchantId=${tenant}&environment=production&runtimeVersion=1.3.0`;
  useEffect(() => {
    if (!valid) { setError('A trusted preview session is required.'); return; }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let revision = -1;
    let cached: { design: StorefrontDesign; revision: number; checksum: string } | undefined;
    async function poll() {
      const request = new AbortController();
      const abort = () => request.abort();
      controller.signal.addEventListener('abort', abort);
      const timeout = setTimeout(abort, 10000);
      try {
        const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: request.signal });
        if (response.headers.get('x-preview-session') !== id) throw new Error('Invalid preview session');
        if (!response.ok) throw new Error('Draft unavailable. Check the preview session.');
        const next = Number(response.headers.get('x-preview-revision'));
        const checksum = response.headers.get('x-config-checksum') || '';
        if (!Number.isSafeInteger(next) || next < 1 || next < revision || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error('Invalid draft revision');
        const body = await response.text();
        if (body.length > 2 * 1024 * 1024 || await digestStringAsync(CryptoDigestAlgorithm.SHA256, body) !== checksum) throw new Error('Draft checksum mismatch');
        if (cached && next === cached.revision && checksum !== cached.checksum) throw new Error('Conflicting draft revision');
        const design = cached && next === cached.revision ? cached.design : designFromDraft(JSON.parse(body), tenant);
        let totalBytes = 0;
        const images = new Map<string, string>();
        for (const section of design.sections) {
          if (section.type !== 'heroBanner' || (cached && next === cached.revision)) continue;
          const assetIDs = [section.image, ...(section.additionalImages || [])];
          for (const assetID of assetIDs) {
          if (!images.has(assetID)) {
            const asset = await fetch(url.replace('?', `/assets/${assetID}?`), { headers: { Authorization: `Bearer ${token}` }, signal: request.signal });
            if (!asset.ok || asset.headers.get('content-type') !== 'image/png') throw new Error('Preview image unavailable');
            const bytes = new Uint8Array(await asset.arrayBuffer());
            totalBytes += bytes.length;
            if (bytes.length > 5 * 1024 * 1024 || totalBytes > 20 * 1024 * 1024) throw new Error('Preview images exceed size limit');
            const checksum = Array.from(new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, bytes))).map(b => b.toString(16).padStart(2, '0')).join('');
            if (checksum !== asset.headers.get('x-asset-checksum')) throw new Error('Preview image checksum mismatch');
            let binary = '';
            for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
            images.set(assetID, `data:image/png;base64,${btoa(binary)}`);
          }
          }
          section.image = images.get(assetIDs[0]!)!;
          section.additionalImages = assetIDs.slice(1).map(id => images.get(id)!);
        }
        if (controller.signal.aborted) return;
        revision = next; cached = { design, revision: next, checksum }; setDraft(cached); setError('');
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Preview disconnected'); }
      clearTimeout(timeout); controller.signal.removeEventListener('abort', abort);
      if (!controller.signal.aborted) timer = setTimeout(poll, 4000);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [url, token, valid, tenant]);
  // Effects run after React commits the shared native renderer.
  useEffect(() => {
    if (!draft || !valid) return;
    const controller = new AbortController();
    const ack = url.replace('?', '/ack?');
    void fetch(ack, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: draft.revision, checksum: draft.checksum }), signal: controller.signal })
      .then(r => { if (!r.ok) throw new Error('Draft acknowledgement failed'); })
      .catch(() => { if (!controller.signal.aborted) setError('Draft acknowledgement unavailable'); });
    return () => controller.abort();
  }, [draft, url, token, valid]);
  return <SafeAreaProvider><View style={{ flex: 1 }}>
    {!!error && <Text accessibilityRole="alert" style={{ padding: 12, backgroundColor: '#fff1df' }}>{error}</Text>}
    <LiveStorefront configuration={{ ...liveConfiguration, design: draft?.design }} />
  </View></SafeAreaProvider>;
}
