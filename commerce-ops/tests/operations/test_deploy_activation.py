"""Exercise activation with real local rsync and advisory locks, never EC2."""
import fcntl
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]


@unittest.skipUnless(shutil.which('rsync'), 'rsync is required')
class ActivationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.active = self.base / 'active'
        self.upload = self.base / 'upload'
        self.source = self.upload / 'source'
        self.bin = self.base / 'bin'
        self.bin.mkdir()
        for name in ('commerce-api/rocento-api/migrations', 'commerce-web', 'commerce-web/apps/rengine', 'commerce-assistant-platform',
                     'commerce-ops/scripts', 'commerce-ops/deploy/ec2/server', 'commerce-ops/cloud/host', 'commerce-ops/deploy/shared', 'commerce-ops/services/assistant', 'commerce-ops/services/contact', 'commerce-ops/compose/base'):
            (self.source / name).mkdir(parents=True, exist_ok=True)
        (self.upload / 'config').mkdir()
        (self.upload / 'ready').touch()
        for name in ('bootstrap.env', 'rocento-origin.pem', 'rocento-origin.key', 'notifications.env', 'contact.env'):
            (self.upload / 'config' / name).write_text('candidate ' + name)
        for name in ('commerce-ops/compose/base/compose.yaml', 'commerce-api/rocento-api/migrations/new.sql',
                     'commerce-ops/deploy/ec2/server/cleanup.py', 'commerce-web/current.txt'):
            (self.source / name).write_text('new release')
        shutil.copy2(ROOT / 'commerce-ops/deploy/ec2/server/ec2-source-filters.sh', self.source / 'commerce-ops/deploy/ec2/server/ec2-source-filters.sh')
        lib = self.source / 'commerce-ops/cloud/lib'
        lib.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / 'commerce-ops/cloud/lib/source-filters.sh', lib / 'source-filters.sh')
        shutil.copy2(ROOT / 'commerce-ops/deploy/ec2/server/ec2-up.sh', self.source / 'commerce-ops/deploy/ec2/server/ec2-up.sh')
        shutil.copy2(ROOT / 'commerce-ops/cloud/host/deploy.sh', self.source / 'commerce-ops/cloud/host/deploy.sh')
        shutil.copy2(ROOT / 'commerce-ops/cloud/host/compose.sh', self.source / 'commerce-ops/cloud/host/compose.sh')
        shutil.copy2(ROOT / 'commerce-ops/cloud/host/deployment_job.py', self.source / 'commerce-ops/cloud/host/deployment_job.py')
        shutil.copy2(ROOT / 'commerce-ops/cloud/host/check.py', self.source / 'commerce-ops/cloud/host/check.py')
        shutil.copy2(ROOT / 'commerce-ops/cloud/host/seed-demo.sh', self.source / 'commerce-ops/cloud/host/seed-demo.sh')
        shutil.copy2(ROOT / 'commerce-ops/cloud/host/bootstrap.sh', self.source / 'commerce-ops/cloud/host/bootstrap.sh')
        shutil.copy2(ROOT / 'commerce-ops/cloud/host/cleanup.py', self.source / 'commerce-ops/cloud/host/cleanup.py')
        shutil.copy2(ROOT / 'commerce-ops/cloud/host/preserve_ai.py', self.source / 'commerce-ops/cloud/host/preserve_ai.py')
        for name in ('server.py', 'rocento-contact.service', 'activate.sh'):
            shutil.copy2(ROOT / 'commerce-ops/services/contact' / name,
                          self.source / 'commerce-ops/services/contact' / name)
        shutil.copy2(ROOT / 'commerce-ops/deploy/ec2/server/repository-root.sh', self.source / 'commerce-ops/deploy/ec2/server/repository-root.sh')
        (self.source / 'commerce-api/rocento-api/Cargo.toml').write_text('[workspace]')
        shutil.copy2(ROOT / 'commerce-ops/cloud/host/render_config.py', self.source / 'commerce-ops/cloud/host/render_config.py')
        shutil.copy2(ROOT / 'commerce-ops/deploy/ec2/build-frontend.sh', self.source / 'commerce-ops/deploy/ec2/build-frontend.sh')
        (self.source / 'commerce-ops/workflows/release').mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / 'commerce-ops/workflows/release/build-frontend.sh', self.source / 'commerce-ops/workflows/release/build-frontend.sh')
        self.protected = [
            'deploy/ec2/bootstrap.env', 'deploy/ec2/common.yaml', 'deploy/ec2/grocery.yaml',
            'deploy/ec2/jewelry.yaml', 'deploy/ec2/electronics.yaml', 'deploy/ec2/pharmacy.yaml',
            'deploy/ec2/grocery-assistant.env', 'deploy/ec2/state/frontend.sha256',
            'deploy/ec2/assistant/grocery/private.pem', 'deploy/ec2/public/index.html',
            'deploy/ec2/shared-ai/language-owner.env', 'deploy/ec2/card-details.ABC123/private.json',
            'deploy/ec2/grocery.seeded', 'deploy/rengine-private/key',
            'deploy/rengine-private/data/connections.enc', 'deploy/custom-runtime/state',
            'commerce-ops/deploy/assistant/ingress.conf',
            'commerce-ops/deploy/observability/collector.yaml',
            'commerce-web/.env.production', 'commerce-web/node_modules/cache', 'uploads/customer.jpg',
        ]
        self.stale = ['commerce-web/retired.txt', 'commerce-assistant-platform/removed.py', 'commerce-api/rocento-api/migrations/old.sql',
                      'commerce-ops/services/assistant/retired.conf', 'commerce-ops/compose/compose.retired.yaml', 'Rocento-Codex/old.txt']
        for name in self.protected + self.stale:
            path = self.active / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('production ' + name)
        self.lock = self.active / 'deploy/ec2/setup.lock'
        self.lock.touch()
        self.lock_inode = self.lock.stat().st_ino

        # macOS lacks util-linux flock. This uses the same real advisory lock on
        # the inherited open file description; it is not a mocked lock outcome.
        self.executable('flock', '''import fcntl, sys
try:
    fcntl.flock(int(sys.argv[-1]), fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(1)
''')
        self.executable('assert-locked', '''import fcntl, os
with open(os.environ['TEST_LOCK'], 'a') as lock:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        with open(os.environ['TEST_LOCK'] + '.checks', 'a') as checks:
            print('lock-held', file=checks)
    else:
        raise SystemExit('deployment lock was released too early')
''')
        rsync = shutil.which('rsync')
        self.executable('rsync', f'''import os, subprocess, sys
subprocess.run(['assert-locked'], check=True)
args = [arg for arg in sys.argv[1:] if not arg.startswith('--chown=')]
if os.environ.get('FAIL_MIRROR') == '1':
    sys.exit(23)
os.execv({rsync!r}, [{rsync!r}, *args])
''')
        install = shutil.which('install')
        self.executable('install', f'''import os, sys
args = []
values = iter(sys.argv[1:])
for value in values:
    if value in ('-o', '-g'):
        next(values)
    elif value == '-D':
        os.makedirs(os.path.dirname(sys.argv[-1]), exist_ok=True)
    else:
        args.append(value)
os.execv({install!r}, [{install!r}, *args])
''')
        # Isolate transport/locking from the separately tested evidence validator.
        gate = self.source / 'commerce-ops/workflows/release/deployment_gate.py'
        gate.parent.mkdir(parents=True, exist_ok=True)
        gate.write_text("import os, subprocess, sys\nsubprocess.run(['assert-locked'], check=True)\nsys.exit(int(os.environ.get('TEST_GATE_FAIL', '0')))\n")
        # Run only the production lock handoff inside the deployed script.
        script = (ROOT / 'commerce-ops/cloud/host/deploy.sh').read_text()
        handoff = script.split('    if [[ ${ROCENTO_DEPLOY_LOCK_FD:-}', 1)[1].split('    if [[ -f "$ROOT/commerce-ops/cloud/host/cleanup.py"', 1)[0]
        handoff = 'RELEASE_ARGS=(--fixture)\nif [[ ${ROCENTO_DEPLOY_LOCK_FD:-}' + handoff
        if sys.platform == 'darwin':
            # macOS /dev/fd has device metadata, unlike Linux /proc/fd. Compare
            # the inherited descriptor's actual inode for the equivalent check.
            handoff = handoff.replace(
                '[[ /proc/$$/fd/9 -ef "$ROOT/deploy/ec2/setup.lock" ]]',
                "python3 -c 'import os, sys; sys.exit(not os.path.samestat(os.fstat(9), os.stat(os.environ[\"TEST_LOCK\"])))'")
        (self.source / 'commerce-ops/deploy/ec2/server/ec2-up.sh').write_text(
            'set -euo pipefail\nROOT=' + shlex.quote(str(self.active)) + '\n'
            'fail() { echo "$*" >&2; exit 1; }\n' + handoff + '\nassert-locked\necho deployed\n')
        activation = (ROOT / 'commerce-ops/cloud/host/activate-source.sh').read_text()
        activation = activation.replace('ROOT=/opt/rocento', 'ROOT=' + shlex.quote(str(self.active)))
        activation = activation.replace("[[ $EUID == 0 ]] || fail 'Run with sudo.'", ': # Fixture runs as the local user.')
        activation = activation.replace('/home/ubuntu', str(self.base / 'home/ubuntu'))
        activation = activation.replace('/etc/rocento', str(self.base / 'etc/rocento'))
        self.script = self.source / 'commerce-ops/cloud/host/activate-source.sh'
        self.script.write_text(activation)
        self.env = {**os.environ, 'PATH': str(self.bin) + os.pathsep + os.environ['PATH'],
                    'TEST_LOCK': str(self.lock)}

    def executable(self, name, source):
        path = self.bin / name
        path.write_text('#!' + sys.executable + '\n' + source)
        path.chmod(0o755)

    def activate(self, **env):
        return subprocess.run(['bash', str(self.script)], text=True, capture_output=True,
                              env={**self.env, **env}, timeout=45)

    def test_mirror_removes_deleted_code_preserves_runtime_and_holds_lock_through_deploy(self):
        result = self.activate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('deployed', result.stdout)
        self.assertEqual((self.active / 'deploy/ec2/server/cleanup.py').read_text(), 'new release')
        self.assertFalse((self.active / 'commerce-ops/deploy/aws-deploy').exists())
        self.assertGreaterEqual(Path(str(self.lock) + '.checks').read_text().count('lock-held'), 3)
        self.assertEqual(self.lock.stat().st_ino, self.lock_inode)
        for name in self.stale:
            self.assertFalse((self.active / name).exists(), name)
        for name in self.protected:
            if name != 'deploy/ec2/bootstrap.env':
                self.assertEqual((self.active / name).read_text(), 'production ' + name, name)
        self.assertEqual((self.active / 'commerce-web/current.txt').read_text(), 'new release')
        self.assertEqual((self.active / 'deploy/ec2/bootstrap.env').read_text(), 'candidate bootstrap.env')
        self.assertEqual((self.active / 'deploy/ec2/bootstrap.env').stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.base / 'home/ubuntu/.rocento-migration-backups').exists())

    def test_rejected_release_leaves_source_configuration_and_migrations_untouched(self):
        before = {str(p.relative_to(self.active)): p.read_bytes()
                  for p in self.active.rglob('*') if p.is_file()}
        result = self.activate(TEST_GATE_FAIL='1')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertNotIn('deployed', result.stdout)
        for name, content in before.items():
            self.assertEqual((self.active / name).read_bytes(), content, name)

    def test_busy_lock_leaves_active_source_and_configuration_untouched(self):
        with self.lock.open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.activate()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Another deployment or seed is active', result.stderr)
        self.assertFalse((self.active / 'commerce-web/current.txt').exists())
        for name in self.stale + self.protected:
            self.assertEqual((self.active / name).read_text(), 'production ' + name)

    def test_failed_mirror_does_not_install_configuration_or_start_deployment(self):
        result = self.activate(FAIL_MIRROR='1')
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertNotIn('deployed', result.stdout)
        self.assertEqual((self.active / 'deploy/ec2/bootstrap.env').read_text(), 'production deploy/ec2/bootstrap.env')

    def test_incomplete_upload_cannot_activate(self):
        (self.upload / 'ready').unlink()
        result = self.activate()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('incomplete', result.stderr)
        self.assertTrue((self.active / 'commerce-web/retired.txt').exists())

    def test_preserve_ai_protects_existing_code_and_config_from_mirror(self):
        (self.upload / 'preserve-ai').touch()
        # Snapshot provider is stubbed here; its real Docker/identity behavior has
        # separate tests. The mirror and inherited lock remain real.
        (self.source / 'commerce-ops/cloud/host/preserve_ai.py').write_text(
            'import pathlib, subprocess, sys\nsubprocess.run(["assert-locked"], check=True)\n'
            'pathlib.Path(sys.argv[2]).write_text("{}")\n')
        paths = ('commerce-assistant-platform/app/main.py', 'commerce-assistant-platform/app/commerce_language_engine/data/compiled.json',
                 'commerce-ops/compose/components/compose.language-engine.yaml', 'commerce-ops/compose/components/compose.assistant.yaml',
                 'commerce-ops/services/assistant/policy-answers.json', 'commerce-ops/compose/components/compose.assistant-runtime.yaml')
        for name in paths:
            for root, content in ((self.active, 'verified production'), (self.source, 'experimental candidate')):
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content)
        result = self.activate()
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in paths:
            self.assertEqual((self.active / name).read_text(), 'verified production', name)
        self.assertTrue((self.active / 'commerce-assistant-platform/removed.py').exists())
        self.assertTrue((self.active / 'commerce-ops/services/assistant/retired.conf').exists())
        self.assertFalse((self.active / 'commerce-web/retired.txt').exists())


if __name__ == '__main__':
    unittest.main()
