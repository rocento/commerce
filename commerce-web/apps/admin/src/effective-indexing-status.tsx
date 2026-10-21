import { indexingStatus } from './discovery-status';
import type { EffectiveIndexingPolicy } from '@commerce/api-client';
export function EffectiveIndexingStatus({ policy }: { policy: EffectiveIndexingPolicy }) {
  return <details className="form-card visibility-card visibility-technical"><summary>View indexing details</summary>
    <dl className="visibility-facts">
      <dt>Current indexing status</dt><dd>{indexingStatus(policy).label}</dd>
      <dt>Saved indexing preference</dt><dd>{policy.merchant_preference ? 'Allowed' : 'Disabled'}</dd>
      <dt>Environment</dt><dd>{policy.environment || 'Not configured'}</dd>
      <dt>Approved production domain</dt><dd>{policy.canonical_origin || 'Not verified'}</dd>
      <dt>Response header (X-Robots-Tag)</dt><dd>{policy.response_header}</dd>
      <dt>Page indexing directive</dt><dd>{policy.robots_meta}</dd>
      <dt>Deployment indexing block</dt><dd>{policy.deployment_override ? 'Active' : 'Inactive'}</dd>
      <dt>External CDN headers</dt><dd>Not observed — verify the public response before launch.</dd>
      <dt>Saved revision</dt><dd>{policy.settings_revision}</dd>
    </dl><details><summary>robots.txt policy</summary><pre>{policy.robots_txt}</pre></details>
    {policy.warnings.map(warning => <p key={warning} className="help">{warning}</p>)}
    <p className="help">Applies to public storefront pages. Private pages and APIs remain excluded from indexing. Unsaved preferences do not change the current status.</p>
  </details>;
}
