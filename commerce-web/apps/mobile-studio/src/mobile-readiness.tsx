import type { MobileConfig, MobileIssue } from '@commerce/api-client';

type Destination = 'Brand & theme' | 'Sections' | 'Navigation' | 'Features' | 'Languages' | 'Assets' | 'Native Preview';
function destination(path: string): Destination {
  if (path.includes('Asset')) return 'Assets';
  if (path.startsWith('/brand')) return 'Brand & theme';
  if (path.startsWith('/navigation')) return 'Navigation';
  if (path.startsWith('/features')) return 'Features';
  if (path.startsWith('/localization')) return 'Languages';
  return 'Sections';
}

export function MobileReadiness({ config, issues, saved, validated, owner, openPanel }: {
  config: MobileConfig; issues: MobileIssue[]; saved: boolean; validated: boolean; owner: boolean;
  openPanel: (panel: Destination) => void;
}) {
  const checks = issues.filter((issue, index) => issues.findIndex(other => other.path === issue.path && other.code === issue.code) === index);
  return <div aria-label="Release readiness report">
    <p>Review your current draft before releasing it to customers. Backend validation and owner approval are required for publication.</p>
    <h3>Draft checks</h3>
    <ul>
      <li>{saved ? 'Draft saved' : 'Save pending — resolve any errors and wait for autosave.'}</li>
      <li>{checks.length ? `${checks.length} validation issue${checks.length === 1 ? '' : 's'} to resolve` : 'Local contract checks passed'}</li>
      <li>{validated ? 'Current draft validated by the backend' : 'Backend validation required — use Validate draft after saving.'}</li>
      <li>{owner ? 'Owner approval required in Review & publish' : 'An owner must approve and publish this release.'}</li>
    </ul>
    {checks.length > 0 && <ol aria-label="Validation issues">{checks.map(issue => <li key={`${issue.path}:${issue.code}`}>
      <strong>{issue.code.replaceAll('_', ' ')}</strong> <code>{issue.path || '/'}</code>{' '}
      <button type="button" onClick={() => openPanel(destination(issue.path))}>Open {destination(issue.path)}</button>
    </li>)}</ol>}
    <h3>Native compatibility</h3>
    <dl>
      <dt>Configuration schema</dt><dd>{config.schemaVersion}</dd>
      <dt>Minimum iOS runtime</dt><dd>{config.compatibility.minIosRuntime}</dd>
      <dt>Minimum Android runtime</dt><dd>{config.compatibility.minAndroidRuntime}</dd>
      <dt>Home sections</dt><dd>{config.screens.home.sections.length} / 30</dd>
      <dt>Languages</dt><dd>{config.localization.supportedLocales.join(', ')} · Default: {config.localization.defaultLocale}</dd>
    </dl>
    <p>Runtime requirements increase automatically when you add supported capabilities. Existing higher requirements are preserved.</p>
    <h3>Device verification</h3>
    <p>Verify the current design on both native platforms, including Arabic, navigation and shopping flows. A browser simulation or native acknowledgement alone does not prove release readiness.</p>
    <button type="button" onClick={() => openPanel('Native Preview')}>Open Native Preview</button>
    <p>Signing, app-store distribution and push delivery require separate setup and verification.</p>
  </div>;
}
