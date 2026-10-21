import { AndroidServerControls } from './android-server-controls';
import { NativePreviewVideo } from './native-preview-video';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { mobileApi, MobileApiError, type MobileEnvironment, type MobilePreviewSessionStatus } from '@commerce/api-client';
import { isPreviewTarget, readPreviewSession, writePreviewSession, type PreviewTarget } from './native-preview-storage';

export function NativePreviewSession({ merchant, environment, savedRevision, hasLocalChanges, previewContainer, onActiveChange, owner = false }: {
  merchant: string; environment: MobileEnvironment; savedRevision?: number; hasLocalChanges: boolean;
  previewContainer?: HTMLElement | null; owner?: boolean; onActiveChange?: (active: boolean) => void;
}) {
  const ec2Enabled = import.meta.env.VITE_ANDROID_EC2_ENABLED === 'true';
  const iosAvailable = import.meta.env.VITE_IOS_PREVIEW_ENABLED !== 'false';
  const rnAvailable = import.meta.env.VITE_RN_PREVIEW_ENABLED === 'true';
  const rnAndroidAvailable = rnAvailable || import.meta.env.VITE_RN_ANDROID_PREVIEW_ENABLED === 'true';
  const fallbackTarget = ec2Enabled || !iosAvailable ? 'android' : 'ios';
  const availableTarget = (value: unknown): value is PreviewTarget => isPreviewTarget(value) && (
    value === 'android' || value === 'ios' && iosAvailable ||
    value === 'react-native-android' && rnAndroidAvailable ||
    value === 'react-native-ios' && rnAvailable && iosAvailable
  );
  const [serverReady, setServerReady] = useState(false);
  const preferenceKey = `rocento.preview-platform:${merchant}:${environment}`;
  const sessionKey = `rocento.preview-session:${merchant}:${environment}`;
  const [restoredSession] = useState(() => readPreviewSession(sessionKey));
  const [target, setTarget] = useState<PreviewTarget>(() => {
    if (restoredSession) return restoredSession.target;
    try { const saved = localStorage.getItem(preferenceKey); return availableTarget(saved) ? saved : fallbackTarget; }
    catch { return fallbackTarget; }
  });
  function selectPlatform(value: string) {
    if (!isPreviewTarget(value)) return;
    setTarget(value);
    try { localStorage.setItem(preferenceKey, value); } catch { /* Storage may be unavailable. */ }
  }
  const platform = target.endsWith('android') ? 'android' : 'ios';
  const framework = target.startsWith('react-native') ? 'react-native' : 'native';
  const selectedRnAvailable = platform === 'android' ? rnAndroidAvailable : rnAvailable && iosAvailable;
  const implementation = framework === 'react-native' ? 'React Native' : platform === 'android' ? 'Kotlin · Jetpack Compose' : 'Swift · SwiftUI';
  const label = platform === 'android' ? 'Android' : 'iOS';
  const [session, setSession] = useState<{ id: string; expiresAt: string; code?: string } | undefined>(() => restoredSession);
  const [status, setStatus] = useState<MobilePreviewSessionStatus>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [feedbackContainer, setFeedbackContainer] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    // Remember only the authenticated worker session, never a manual connection code.
    writePreviewSession(sessionKey, session && !session.code && Date.parse(session.expiresAt) > Date.now()
      ? { id: session.id, expiresAt: session.expiresAt, target } : undefined);
  }, [sessionKey, session, target]);
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    function endSession() {
      writePreviewSession(sessionKey);
      setSession(undefined); setStatus(undefined); setOnline(false);
      setError('Preview session ended. Open a new preview.');
    }
    async function poll() {
      if (Date.now() >= Date.parse(session!.expiresAt)) { endSession(); return; }
      try {
        const result = await mobileApi.previewStatus(merchant, session!.id, controller.signal);
        if (controller.signal.aborted) return;
        if (result.revokedAt || Date.now() >= Date.parse(result.expiresAt)) { endSession(); return; }
        setStatus(result); setOnline(true); setError('');
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof MobileApiError && [401, 403, 404, 410].includes(e.status)) { endSession(); return; }
        setOnline(false); setError('Preview status unavailable. Retrying…');
      }
      setNow(Date.now());
      if (!controller.signal.aborted) timer = setTimeout(poll, 3000);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [merchant, session, sessionKey]);
  async function start(local = false) {
    setBusy(true); setError('');
    try { setSession(await (local ? mobileApi.startPreview(merchant, environment) : mobileApi.startWorkerPreview(merchant, environment, platform, framework))); setStatus(undefined); setOnline(false); setNow(Date.now()); }
    catch (e) {
      setError(e instanceof MobileApiError && e.status === 409
        ? 'Another preview is active or finishing cleanup. Stop it in its original tab, wait for cleanup, then try again.'
        : e instanceof Error ? e.message : 'Unable to start native preview.');
    }
    finally { setBusy(false); }
  }
  async function stop() {
    if (!session) return;
    setBusy(true);
    try { await mobileApi.stopPreview(merchant, session.id); writePreviewSession(sessionKey); setSession(undefined); setStatus(undefined); setOnline(false); setError(''); }
    catch { setError('Unable to stop session. Retry; it will expire automatically.'); }
    finally { setBusy(false); }
  }
  const expired = session && (now >= Date.parse(session.expiresAt) || Boolean(status?.revokedAt));
  const fresh = online && status?.appliedAt && now - Date.parse(status.appliedAt) < 15000;
  const applied = fresh && !expired ? status?.appliedRevision : undefined;
  const synced = applied != null && applied === savedRevision && !hasLocalChanges;
  const active = Boolean(session && !expired);
  useEffect(() => {
    onActiveChange?.(active);
    return () => onActiveChange?.(false);
  }, [active, onActiveChange]);
  const video = active && session && !session.code
    ? <NativePreviewVideo implementation={framework} platform={platform} key={session.id} merchant={merchant} session={session.id}
        feedbackContainer={previewContainer !== undefined ? feedbackContainer : undefined} />
    : null;
  return <div className="ms-native-session">
    <header className="ms-native-session-toolbar">
      {previewContainer === undefined && <h2>Native Preview</h2>}
      <div className="ms-native-target">
        <label><span className="ms-visually-hidden">Preview app</span>
          <select aria-label="Preview app" aria-describedby="preview-target-help" value={target}
            title={active ? 'Stop the preview to switch apps.' : 'Choose an app to preview'}
            disabled={busy || active} onChange={e => selectPlatform(e.target.value)}>
            <optgroup label="Native apps">
              <option value="ios" disabled={!iosAvailable}>iOS · Swift / SwiftUI{!iosAvailable ? " (not connected)" : ""}</option>
              <option value="android">Android · Kotlin / Compose</option>
            </optgroup>
            <optgroup label="React Native">
              <option value="react-native-ios" disabled={!rnAvailable || !iosAvailable}>iOS · React Native{!rnAvailable || !iosAvailable ? " (not connected)" : ""}</option>
              <option value="react-native-android" disabled={!rnAndroidAvailable}>Android · React Native{!rnAndroidAvailable ? " (not connected)" : ""}</option>
            </optgroup>
          </select>
        </label>
      {active ? <button type="button" disabled={busy} onClick={stop}>Stop native preview</button>
        : <button type="button" disabled={busy || (framework === 'react-native' && !selectedRnAvailable) || (platform === 'ios' && !iosAvailable) || (platform === 'android' && ec2Enabled && !serverReady)} onClick={() => start()}>Open {label} Preview</button>}
      </div>
    </header>
    {ec2Enabled && platform === 'android' && <AndroidServerControls merchant={merchant} owner={owner} onReady={setServerReady} />}
    <div className="ms-native-feedback" ref={setFeedbackContainer} />
    {previewContainer === undefined ? video : previewContainer && createPortal(video, previewContainer)}
    {active && session ? <>
      {session.code && <details>
        <summary>Connect local SwiftUI app</summary>
        <p>Open the matching Studio app in iOS Simulator. In App settings → Live native preview, paste this session code. The session expires in 30 minutes.</p>
        <label>Preview session code <input aria-label="Preview session code" type="password" readOnly value={session.code} autoComplete="off" /></label>
        <button type="button" onClick={() => navigator.clipboard.writeText(session.code!).catch(() => setError('Clipboard unavailable. Select and copy the session code.'))}>Copy session code</button>
      </details>}
    </> : <div className="ms-native-empty"><p>Open a preview to see your saved draft.</p></div>}
    <footer className="ms-native-footer">
      {hasLocalChanges && <p>Unsaved changes are not shown in the native preview. Save your draft to update it.</p>}
      <p role="status" className={synced ? 'ms-native-sync is-synced' : 'ms-native-sync'}>{active
        ? applied != null ? `Native applied draft r${applied}${synced ? ' · Up to date' : ' · Waiting for latest saved draft'}` : `Waiting for ${label} preview acknowledgement`
        : expired ? 'Previous session expired or stopped.' : `Saved draft${savedRevision != null ? ` r${savedRevision}` : ''}${hasLocalChanges ? ' · Unsaved changes' : ''}`}</p>
      <details className="ms-native-details">
        <summary>Preview details{framework === 'react-native' ? ' · Pilot' : ''}</summary>
        <div className="ms-native-details-content">
          <p id="preview-target-help">{implementation} · {platform === 'android' ? 'Android Emulator' : 'iOS Simulator'}.
            {active ? ' Stop the preview to switch apps.' : ' Opens the configured native app with your saved draft.'}
          </p>
          {framework === 'react-native' && <p>React Native: banners, product grids and carousels, categories, text and spacers support live section and light-theme edits.</p>}
          <p>Saved section and theme changes update the running app automatically. Select sections in the editor to make changes.</p>
          <p id="native-input-help">Click to tap, drag or scroll to swipe. Click the preview to use your English keyboard. Tab leaves the preview.</p>
          {!active && platform === 'ios' && framework === 'native' && <button type="button" disabled={busy} onClick={() => start(true)}>Connect local app manually</button>}
        </div>
      </details>
    </footer>
    {error && <p role="alert">{error}</p>}
  </div>;
}
