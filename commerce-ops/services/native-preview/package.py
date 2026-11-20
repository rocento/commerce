#!/usr/bin/env python3
"""Package operator-approved signed simulator apps for an existing EC2 Mac host.
No infrastructure is provisioned. No credentials are included in the archive.
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--artifacts', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[3]
manifest = json.loads(args.artifacts.read_text())
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    deployed = {}
    for key, artifact in manifest.items():
        tenant, environment = key.split(':')
        if str(uuid.UUID(tenant)) != tenant or environment not in ('production', 'staging'):
            raise ValueError('invalid artifact identity')
        subprocess.run(['python3', str(repo/'commerce-mobile-apps/tools/check_ios_signing.py'), artifact['app'], '--platform', 'simulator', '--bundle-id', artifact['bundleId'], '--baseline-app', artifact['app']], check=True, capture_output=True)
        target = Path('artifacts') / tenant / environment / 'Preview.app'
        shutil.copytree(artifact['app'], root/target, symlinks=True)
        deployed[key] = dict(app=str(target), bundleId=artifact['bundleId'])
    (root/'artifacts.json').write_text(json.dumps(deployed, indent=2))
    for name in ('worker.py', 'launch.py', 'interactive.py'):
        shutil.copy2(Path(__file__).with_name(name), root/name)
    shutil.copy2(repo/'commerce-mobile-apps/tools/check_ios_signing.py', root/'check_ios_signing.py')
    with tarfile.open(args.output.resolve(), 'w:gz') as archive:
        for path in root.iterdir():
            archive.add(path, arcname=path.name)
print(f'Prepared signed simulator worker package: {args.output.resolve()}')
