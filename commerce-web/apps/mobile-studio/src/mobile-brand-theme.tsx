import { useId, useState } from 'react';
import { mobileApi, type MobileAsset, type MobileConfig } from '@commerce/api-client';
import { MobileThemeControls } from './mobile-theme-controls';
import './mobile-brand-theme.css';

type Brand = MobileConfig['brand'];
const roles = [
  { key: 'primary', label: 'Brand color', help: 'Primary buttons and accents' },
  { key: 'onPrimary', label: 'On-brand text', help: 'Text on primary buttons' },
  { key: 'background', label: 'Page background', help: 'The main screen canvas' },
  { key: 'surface', label: 'Card background', help: 'Cards and content surfaces' },
  { key: 'text', label: 'Body text', help: 'Text on pages and cards' },
] as const;
const isColor = (value: string) => /^#[a-f\d]{6}$/i.test(value);
function contrast(a: string, b: string) {
  if (!isColor(a) || !isColor(b)) return null;
  const luminance = (hex: string) => {
    const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
  };
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
function BrandLogo({ src }: { src?: string }) {
  const [failed, setFailed] = useState(false);
  return src && !failed
    ? <img src={src} alt="Selected brand logo" onError={() => setFailed(true)} />
    : <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4" /><circle cx="8" cy="8" r="1.5" /><path d="m3 17 5-5 4 4 4-6 5 7" /></svg>;
}
export function MobileBrandTheme({ brand, assets, merchant, disabled, change, openAssets, openPreview }: {
  brand: Brand; assets: MobileAsset[]; merchant: string; disabled: boolean;
  change: (patch: Partial<Brand>) => void; openAssets: () => void; openPreview: () => void;
}) {
  const id = useId();
  const logo = assets.find(a => a.id === brand.logoAssetId && a.verified && a.kind === 'image');
  const logoUrl = logo && mobileApi.assetUrl(merchant, logo);
  const checks = [
    { label: 'Button text', ratio: contrast(brand.light.onPrimary, brand.light.primary) },
    { label: 'Page text', ratio: contrast(brand.light.text, brand.light.background) },
    { label: 'Card text', ratio: contrast(brand.light.text, brand.light.surface) },
  ];
  const valid = checks.every(c => c.ratio !== null && c.ratio >= 4.5);
  return <div className="ms-brand-theme">
    <p className="ms-brand-intro">Make your store feel like your brand. Fine-tune the colors and details shared by your native apps.</p>
    <fieldset disabled={disabled}>
      <legend className="ms-visually-hidden">Brand and theme settings</legend>
      <section className="ms-brand-card" aria-labelledby={`${id}-identity`}>
        <header className="ms-brand-card-heading"><span className="ms-brand-step" aria-hidden="true">01</span><div><h3 id={`${id}-identity`}>Brand identity</h3><p>Name and artwork saved with your app configuration.</p></div></header>
        <div className="ms-brand-identity-preview">
          <div className="ms-brand-logo"><BrandLogo key={logoUrl || brand.logoAssetId} src={logoUrl} /></div>
          <div><strong>{brand.displayName || 'Your brand'}</strong><span>{logo?.name || 'Select brand artwork'}</span></div>
        </div>
        <label className="ms-brand-field"><span>App display name <small>{brand.displayName.length}/80</small></span>
          <input aria-label="App display name" value={brand.displayName} maxLength={80} onChange={e => change({ displayName: e.target.value })} />
        </label>
        <label className="ms-brand-field"><span>In-app logo</span>
          <select aria-label="In-app logo" value={brand.logoAssetId} onChange={e => change({ logoAssetId: e.target.value })}>
            <option value={brand.logoAssetId}>{logo?.name || 'Select an uploaded image'}</option>
            {assets.filter(a => a.verified && a.kind === 'image' && a.id !== brand.logoAssetId).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <button type="button" className="ms-brand-text-button" onClick={openAssets}>Manage brand images <span aria-hidden="true">↗</span></button>
      </section>
      <section className="ms-brand-card" aria-labelledby={`${id}-colors`}>
        <header className="ms-brand-card-heading"><span className="ms-brand-step" aria-hidden="true">02</span><div><h3 id={`${id}-colors`}>App colors</h3><p>A considered palette for every screen.</p></div><span className="ms-brand-badge">Light</span></header>
        <div className="ms-brand-palette" aria-hidden="true">{roles.map(({ key }) => <span key={key} style={{ backgroundColor: isColor(brand.light[key]) ? brand.light[key] : undefined }} />)}</div>
        <div className="ms-brand-colors">
          {roles.map(({ key, label, help }) => {
            const invalid = !isColor(brand.light[key]);
            const errorId = `${id}-${key}-error`;
            return <div className="ms-brand-color-row" key={key}>
              <div className="ms-brand-color-label"><label htmlFor={`${id}-${key}`}>{label}</label><small>{help}</small></div>
              <div className={`ms-brand-color-input${invalid ? ' is-invalid' : ''}`}>
                <input type="color" aria-label={`${label} (${key} picker)`} value={invalid ? '#000000' : brand.light[key]} onChange={e => change({ light: { ...brand.light, [key]: e.target.value } })} />
                <input id={`${id}-${key}`} aria-label={`${label} (${key} hex)`} aria-invalid={invalid} aria-describedby={invalid ? errorId : undefined} value={brand.light[key]} maxLength={7} spellCheck={false} autoComplete="off" onChange={e => change({ light: { ...brand.light, [key]: e.target.value } })} />
              </div>
              {invalid && <p className="ms-brand-field-error" id={errorId}>Use a six-digit hex color, such as #B45134.</p>}
            </div>;
          })}
        </div>
        <div className={`ms-brand-contrast${valid ? ' is-valid' : ''}`} aria-label="Color readability" role="status">
          <div><strong>{valid ? 'Readable color pairs' : 'Check color readability'}</strong><span>4.5:1 minimum</span></div>
          {checks.map(({ label, ratio }) => <p key={label}><span>{label}</span><span>{ratio === null ? 'Enter valid colors' : <>{ratio.toFixed(2)}:1 · <span>{ratio >= 4.5 ? 'Pass' : 'Needs contrast'}</span></>}</span></p>)}
        </div>
        <p className="ms-brand-note">Native storefronts currently use the light palette. Your saved dark palette is preserved.</p>
      </section>
      <section className="ms-brand-card" aria-labelledby={`${id}-layout`}>
        <header className="ms-brand-card-heading"><span className="ms-brand-step" aria-hidden="true">03</span><div><h3 id={`${id}-layout`}>Shape & spacing</h3><p>Give your interface a consistent feel.</p></div></header>
        <MobileThemeControls brand={brand} change={change} />
        <div className="ms-brand-type"><span aria-hidden="true">Aa</span><div><strong>Native system typography</strong><p>Uses each platform’s system font and accessibility settings.</p></div></div>
      </section>
    </fieldset>
    <div className="ms-brand-handoff"><div><strong>See it in your app</strong><p>Saved theme changes sync to a running native preview.</p></div><button type="button" onClick={openPreview}>Open Native Preview <span aria-hidden="true">→</span></button></div>
    <details className="ms-brand-build-details"><summary>What needs a new app build?</summary><p>Launcher icons and launch screens are configured in native builds. Saving this name and logo does not change the current native header.</p></details>
  </div>;
}
