import { useEffect, useId, useState } from 'react';
import './install-app.css';
import { themeOptions, useTheme } from './theme-sections';

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** Discover installation metadata after load on every route, including checkout. */
export function deferInstallManifest() {
  const load = () => {
    if (document.querySelector('link[rel="manifest"]')) return;
    const manifest = document.createElement('link');
    manifest.rel = 'manifest'; manifest.href = '/manifest.webmanifest';
    document.head.append(manifest);
  };
  if (document.readyState === 'complete') load();
  else window.addEventListener('load', load, { once: true });
}

/** Installation only: no service worker, offline cache, or background requests. */
export function InstallApp() {
  const options = themeOptions(useTheme(), 'footer_options', 'bottom');
  const text = (key: string) => String(options[key] || '');
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [platform, setPlatform] = useState<'ios' | 'android' | null>(null);
  const [installed, setInstalled] = useState(true);
  const [help, setHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  const helpId = useId();

  useEffect(() => {
    const standalone = window.matchMedia('(display-mode: standalone)');
    const updateDisplay = () => setInstalled(standalone.matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
    updateDisplay();
    if (!window.isSecureContext) return;
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    setPlatform(ios ? 'ios' : /Android/.test(navigator.userAgent) ? 'android' : null);
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPrompt);
      setHelp(false);
    };
    const onInstalled = () => { setInstalled(true); setPrompt(null); setHelp(false); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    standalone.addEventListener('change', updateDisplay);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      standalone.removeEventListener('change', updateDisplay);
    };
  }, []);

  async function install() {
    if (!prompt) { setHelp(value => !value); return; }
    setBusy(true);
    try {
      await prompt.prompt();
      if ((await prompt.userChoice).outcome === 'accepted') setInstalled(true);
    } catch {
      setHelp(true);
    } finally {
      // Browser prompt events can only be used once, including after dismissal.
      setPrompt(null);
      setBusy(false);
    }
  }

  if (installed || (!prompt && !platform && !help)) return null;
  return <div className="store-install">
    <button type="button" onClick={install} disabled={busy} aria-expanded={help} aria-controls={helpId}>
      {busy ? text('install_pending_label') : text('install_label')}
    </button>
    <div id={helpId} hidden={!help}>
      <p>{text(platform === 'ios' ? 'install_ios_help' : platform === 'android' ? 'install_android_help' : 'install_browser_help')}</p>
      <p>{text('install_connection_notice')}</p>
    </div>
  </div>;
}
