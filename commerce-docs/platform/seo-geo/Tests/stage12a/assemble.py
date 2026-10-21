"""Snapshot explicit source inputs; exclude secrets, dependencies and generated outputs."""
from pathlib import Path
import hashlib, json, shutil, subprocess
root = Path(__file__).resolve().parents[5]
target = Path('/tmp/rocento-stage12a-candidate')
if target.exists():
    raise SystemExit('Candidate already exists; do not overwrite')
target.mkdir()
allowed = {'.rs','.toml','.lock','.sql','.json','.ts','.tsx','.js','.jsx','.mjs','.cjs','.css','.html','.svg','.png','.jpg','.jpeg','.webp','.woff','.woff2','.yaml','.yml','.py','.sh','.md','.txt'}
excluded = {'node_modules','target','.git','__pycache__','dist','dist-server','.stage11-dist','.stage11-dist-server','test-results','playwright-report','.venv','website'}
files = {}
for base in ['backend','frontend','deploy','scripts','demo-presets','contracts','commerce-ai-docs','assets','commerce-ai-docs/platform/seo-geo/Tests/stage11','commerce-ai-docs/platform/seo-geo/Tests/stage11-release']:
    for p in (root/base).rglob('*'):
        rel = p.relative_to(root)
        if base == 'docs' and rel.parts[:2] == ('docs', 'seo-geo'): continue
        if any(part in excluded or part.startswith('.env') for part in rel.parts): continue
        if not p.is_file() or p.is_symlink() or (p.suffix not in allowed and p.name != 'Dockerfile'): continue
        data = p.read_bytes(); dest = target/rel; dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data)
        files[str(rel)] = hashlib.sha256(data).hexdigest()
for name in [str(p.relative_to(root)) for p in root.glob('compose*.yaml')]:
    data=(root/name).read_bytes();(target/name).write_bytes(data);files[name]=hashlib.sha256(data).hexdigest()
# Explicit nonproduction test credentials and deployment fixtures, never real keys/env files.
extras = [root/'deploy/ec2/bootstrap.env.example', *list((root/'backend/crates/api-gateway/tests/fixtures').glob('*.pem'))]
extras += [p for p in (root/'deploy/aws-deploy').rglob('*') if p.is_file() and p.suffix in {'.py','.sh','.yaml','.json','.md'}]
for p in extras:
    rel=p.relative_to(root);data=p.read_bytes();dest=target/rel;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data);dest.chmod(p.stat().st_mode & 0o777);files[str(rel)]=hashlib.sha256(data).hexdigest()

# Reuse installed JS dependencies without mutating them; separately record their lock identity.
for parent in [root/'frontend', *list((root/'frontend/apps').iterdir()), *list((root/'frontend/packages').iterdir())]:
    dep=parent/'node_modules'
    if dep.exists() and parent.name != 'website':
        dest=target/dep.relative_to(root);dest.parent.mkdir(parents=True,exist_ok=True);dest.symlink_to(dep,target_is_directory=True)
manifest={'candidate':str(target),'base_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'scope':'selected current source snapshot including uncommitted/untracked dependencies; not deployable clean commit','sha256':dict(sorted(files.items())),'dependencies':'Installed frontend node_modules reused read-only by convention; lockfiles hashed, no package reinstall','excluded':'corporate website, generated outputs, secret files and dependency directories'}
for lock in [root/'frontend/node_modules/.pnpm/lock.yaml',root/'frontend/node_modules/.modules.yaml']:
    if lock.exists():manifest.setdefault('installed_dependency_metadata_sha256',{})[str(lock.relative_to(root))]=hashlib.sha256(lock.read_bytes()).hexdigest()
(root/'commerce-ai-docs/platform/seo-geo/Reports/evidence/stage12a/candidate-source.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(f'Snapshotted {len(files)} source inputs to {target}')
