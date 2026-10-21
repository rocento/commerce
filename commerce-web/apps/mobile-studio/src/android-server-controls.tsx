import './mobile-studio.css';
import { useEffect, useState } from 'react';
import { mobileApi, MobileApiError, type AndroidServerStatus } from '@commerce/api-client';

export function AndroidServerControls({ merchant, owner, onReady }: { merchant: string; owner: boolean; onReady: (ready: boolean) => void }) {
  const [status, setStatus] = useState<AndroidServerStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await mobileApi.androidServerStatus(merchant, controller.signal);
        if (controller.signal.aborted) return;
        setStatus(value); onReady(value.ready && value.activeSessions === 0);
      } catch {
        if (controller.signal.aborted) return;
        setStatus(undefined); onReady(false);
      }
      timer = setTimeout(poll, 5000);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); onReady(false); };
  }, [merchant, onReady]);
  async function control(action: 'start' | 'stop') {
    setBusy(true); setError('');
    try {
      const value = await mobileApi.androidServerControl(merchant, action);
      setStatus(value); onReady(value.ready && value.activeSessions === 0);
    } catch (e) {
      setError(e instanceof MobileApiError && e.status === 409
        ? 'End all previews and wait for cleanup before changing the server state.'
        : 'Unable to change server state. Refresh status and retry.');
    } finally { setBusy(false); }
  }
  const label = !status ? 'Checking connection…' : status.ready ? 'Ready' : status.state === 'running' || status.state === 'pending' ? 'Starting…' : status.state === 'stopping' ? 'Stopping…' : status.state === 'stopped' ? 'Stopped' : 'Unavailable';
  return <div className="ms-android-server" aria-label="Android server controls">
    <p role="status">Android server · {label}{status?.activeSessions ? ` · ${status.activeSessions} active preview` : ''}</p>
    {Boolean(status?.activeSessions) && <p>The shared preview slot is in use. Stop the active preview and wait for cleanup before opening another.</p>}
    {owner && <div className="ms-android-server-actions">
      <button type="button" disabled={busy || status?.state !== 'stopped'} onClick={() => void control('start')}>Start Android server</button>
      <button type="button" disabled={busy || !status?.ready || status.activeSessions !== 0} onClick={() => void control('stop')}>Stop Android server</button>
    </div>}
    <small>{owner ? 'Stop the server after testing to avoid idle compute charges. Disk and IP charges continue.' : 'An owner can start or stop this server.'} Kotlin and React Native share one preview slot. Fresh previews can take about 90 seconds to open.</small>
    {error && <p role="alert">{error}</p>}
  </div>;
}
