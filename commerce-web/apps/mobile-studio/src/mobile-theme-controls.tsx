import type { MobileConfig } from '@commerce/api-client';
import { cornerPresets } from './mobile-studio-model';

type Brand = MobileConfig['brand'];
export function MobileThemeControls({ brand, change }: {
  brand: Brand;
  change: (patch: Partial<Brand>) => void;
}) {
  return <section className="ms-theme-controls" aria-label="Component styling">

    <fieldset className="ms-theme-options">
      <legend>Corner radius</legend>
      <div className="ms-radius-options">
        {cornerPresets.map(p => <label key={p.token}>
          <input type="radio" name="theme-radius" value={p.token} checked={brand.radiusToken === p.token}
            onChange={() => change({ radiusToken: p.token })} />
          <span className="ms-radius-option">
            <span className="ms-radius-swatch" style={{ borderRadius: p.radius }} aria-hidden="true" />
            <strong>{p.label}</strong><small>{p.radius} px</small>
          </span>
        </label>)}
      </div>
    </fieldset>
    <fieldset className="ms-theme-options">
      <legend>Spacing</legend>
      <div className="ms-spacing-options">
        {(['compact', 'comfortable'] as const).map(density => <label key={density}>
          <input type="radio" name="theme-density" checked={brand.density === density}
            onChange={() => change({ density })} />
          <span><strong>{density === 'compact' ? 'Compact' : 'Comfortable'}</strong><small>{density === 'compact' ? '12 px · more content' : '20 px · more breathing room'}</small></span>
        </label>)}
      </div>
    </fieldset>
    <p className="ms-brand-note">Sizes map to native points on iOS and density-independent pixels on Android.</p>
  </section>;
}
