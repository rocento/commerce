import type { MobileConfig } from '@commerce/api-client';
import { NativePreviewSession } from './native-preview-session';

/** Server draft revisions and published config versions are separate sequences. */
export function MobilePreviewStatus({ config, environment, savedRevision, hasLocalChanges = false, readOnly = false }: {
  config: MobileConfig;
  environment?: "staging" | "production";
  savedRevision?: number;
  hasLocalChanges?: boolean;
  readOnly?: boolean;
}) {
  const source = readOnly && config.configVersion > 0
    ? `Published version ${config.configVersion}`
    : hasLocalChanges
      ? `Local changes${savedRevision ? ` · based on draft r${savedRevision}` : ''}`
      : savedRevision ? `Saved draft r${savedRevision}` : 'Local draft';
  return <aside className="ms-live-preview-status" aria-label="Preview status">
    <strong>Draft preview status</strong>
    <p role="status">{source} · Web preview updated</p>
    {!readOnly && environment ? <NativePreviewSession key={`${config.tenantId}:${environment}`} merchant={config.tenantId} environment={environment} savedRevision={savedRevision} hasLocalChanges={hasLocalChanges} /> : <p>Native preview is not connected.</p>}
    <details>
      <summary>Definition compatibility</summary>
      <p>Schema {config.schemaVersion} · Requires iOS runtime {config.compatibility.minIosRuntime} · Android runtime {config.compatibility.minAndroidRuntime}</p>
      <p>A native acknowledgement confirms that the connected iOS runtime accepted the definition. Video visibility is tracked separately.</p>
    </details>
  </aside>;
}
