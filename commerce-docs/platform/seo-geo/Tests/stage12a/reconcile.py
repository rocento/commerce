"""Audit candidate/artifact identities and current publication documentation."""
from pathlib import Path
import hashlib, json, subprocess
root=Path(__file__).resolve().parents[5]
evidence=root/'commerce-ai-docs/platform/seo-geo/Reports/evidence/stage12a'
m=json.loads((evidence/'candidate-source.json').read_text());candidate=Path(m['candidate'])
missing=[];changed=[]
for path,digest in m['sha256'].items():
    p=candidate/path
    if not p.exists():missing.append(path)
    elif hashlib.sha256(p.read_bytes()).hexdigest()!=digest:changed.append(path)
# Historical Markdown reports were removed during service-doc consolidation.
# Retain the output key for consumers, and inventory the new owning guides.
reports=[]
guides=[]
for relative in ['commerce-ai-docs/frontend/publication.md', 'commerce-ai-docs/backend/publication.md']:
    p=root/relative
    assert p.is_file(),relative
    guides.append({'path':relative,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
artifacts={}
for folder in ['frontend/apps/storefront/dist','frontend/apps/storefront/dist-server','frontend/apps/admin/dist']:
    for p in sorted((candidate/folder).rglob('*')):
        if p.is_file():artifacts[str(p.relative_to(candidate))]=hashlib.sha256(p.read_bytes()).hexdigest()
seal=json.loads((candidate/'frontend/apps/storefront/dist/publication-build.json').read_text())
assert seal['template']==artifacts['frontend/apps/storefront/dist/public.html']
assert seal['server']==artifacts['frontend/apps/storefront/dist-server/entry-public-server.js']
workspace_drift=[path for path,digest in m['sha256'].items() if path.startswith('frontend/') and (not (root/path).exists() or hashlib.sha256((root/path).read_bytes()).hexdigest()!=digest)]
shared_drift=[path for path in workspace_drift if path.startswith('frontend/packages/')]
dependency_drift=[path for path,digest in m.get('installed_dependency_metadata_sha256',{}).items() if hashlib.sha256((root/path).read_bytes()).hexdigest()!=digest]
result={'original_frontend_workspace_drift':workspace_drift,'shared_frontend_source_drift':shared_drift,'installed_dependency_metadata_drift':dependency_drift,'status':'Verified' if not missing and not changed and not shared_drift and not dependency_drift else 'Blocked','scope':'source-copy identity, artifact seal and current publication guide inventory; not a live release gate','candidate_files':len(m['sha256']),'missing':missing,'changed':changed,'reports':reports,'historical_markdown_reports_removed':True,'guides':guides,'artifact_sha256':artifacts}
(evidence/'reconciliation.json').write_text(json.dumps(result,indent=2)+'\n')
assert result['status']=='Verified', {'missing':missing,'changed':changed,'shared_drift':shared_drift,'dependency_drift':dependency_drift}
print(f'Verified {len(m["sha256"])} candidate inputs, {len(guides)} publication guides and {len(artifacts)} artifact hashes')
