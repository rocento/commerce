"""Check local seed routing with a fake SSH transport; never contact EC2."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import tarfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
SEED_FILES = ('commerce-ops/deploy/ec2/server/ec2-seed-demo.sh', 'commerce-ops/scripts/demo/seed-demo-storefront.py', 'commerce-ops/scripts/demo/demo_presets.py',
              'commerce-ops/scripts/demo/sync-grocery-palette.py', 'commerce-ops/scripts/demo/grocery_palette.py',
              'commerce-ops/scripts/demo/seed-demo-storefront.py', 'commerce-ops/scripts/demo/demo_presets.py',
              'commerce-ops/scripts/demo/sync-grocery-palette.py', 'commerce-ops/scripts/demo/grocery_palette.py',
              'commerce-assets/demo/demo_seed.py', 'commerce-assets/demo/seed-category-images.py', 'commerce-assets/demo/seed-delivery-areas.py')


class SeedLauncherTests(unittest.TestCase):
    def run_launcher(self, args, exit_code=0, execute_remote=False, locked=False, seed_exit=0):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            deploy = root / 'commerce-ops/deploy/aws-deploy'
            deploy.mkdir(parents=True)
            shutil.copy2(ROOT / 'commerce-ops/deploy/aws-deploy/seed-demo.sh', deploy / 'seed-demo.sh')
            (deploy / 'rocento.pem').write_text('test placeholder')
            (root / 'commerce-demo').mkdir()
            shutil.copy2(ROOT / 'commerce-demo/egypt-delivery-areas.json', root / 'commerce-demo/egypt-delivery-areas.json')
            for name in SEED_FILES:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / name, target)
            shutil.copytree(ROOT / 'commerce-demo/grocery', root / 'commerce-demo/grocery')
            shutil.copytree(ROOT / 'commerce-assets/demo/Grocery-Items', root / 'commerce-assets/demo/Grocery-Items')
            shutil.copytree(ROOT / 'commerce-demo/pharmacy', root / 'commerce-demo/pharmacy')
            shutil.copytree(ROOT / 'commerce-assets/demo/pharmacy', root / 'commerce-assets/demo/pharmacy')
            remote = root / 'remote'
            if execute_remote:
                for name in ('deploy/ec2/server', 'commerce-assets/demo', 'commerce-demo'):
                    (remote / name).mkdir(parents=True)
                (remote / 'deploy/ec2/server/ec2-bootstrap.sh').touch()
                (remote / 'deploy/ec2/server/ec2-seed-demo.sh').write_text('echo "ERROR: Unknown option: --delivery-areas-stdin" >&2; exit 1\n')
                # Replacement runner records the invocation without touching any real data.
                (root / 'deploy/ec2/server/ec2-seed-demo.sh').write_text('''set -eu
[[ $3 == --delivery-areas-stdin ]]
printf '%s\\n' "$@" > "$FAKE_SEED_ARGS"
cat > "$FAKE_SEED_INPUT"
exit "$FAKE_SEED_EXIT"
''')
            bin_dir = root / 'bin'
            bin_dir.mkdir()
            ssh = bin_dir / 'ssh'
            ssh.write_text('''#!/usr/bin/env python3
import json, os, subprocess, sys
from pathlib import Path
payload = sys.stdin.buffer.read()
Path(os.environ['FAKE_UPLOAD']).write_bytes(payload)
with open(os.environ['FAKE_LOG'], 'a') as log:
    log.write(json.dumps(sys.argv[1:]) + '\\n')
if os.environ['FAKE_EXECUTE_REMOTE'] == '1':
    command = sys.argv[-1].replace('/opt/rocento', os.environ['FAKE_REMOTE'])
    sys.exit(subprocess.run(['bash', '-c', command], input=payload).returncode)
sys.exit(int(os.environ['FAKE_EXIT']))
''')
            ssh.chmod(0o755)
            for name, script in {'sudo': '#!/bin/bash\nshift\nexec "$@"\n',
                                 'flock': '#!/bin/bash\nexit "$FAKE_LOCKED"\n'}.items():
                shim = bin_dir / name
                shim.write_text(script)
                shim.chmod(0o755)
            log = root / 'calls.jsonl'
            upload = root / 'uploaded.tar'
            seed_args, seed_input = root / 'seed-args', root / 'seed-input'
            env = {**os.environ, 'PATH': str(bin_dir) + os.pathsep + os.environ['PATH'], 'FAKE_LOG': str(log), 'FAKE_EXIT': str(exit_code), 'FAKE_UPLOAD': str(upload),
                   'FAKE_EXECUTE_REMOTE': str(int(execute_remote)), 'FAKE_REMOTE': str(remote),
                   'FAKE_LOCKED': str(int(locked)), 'FAKE_SEED_ARGS': str(seed_args),
                   'FAKE_SEED_INPUT': str(seed_input), 'FAKE_SEED_EXIT': str(seed_exit)}
            result = subprocess.run(['bash', str(deploy / 'seed-demo.sh'), *args], env=env, capture_output=True, text=True, timeout=10)
            calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
            result.uploaded = {}
            result.archive_headers = {}
            if upload.exists():
                with tarfile.open(upload) as archive:
                    result.uploaded = {m.name: archive.extractfile(m).read() for m in archive.getmembers() if m.isfile()}
                    result.archive_headers = {member.name: member.pax_headers for member in archive.getmembers()}
            result.seed_args = seed_args.read_text().splitlines() if seed_args.exists() else None
            result.seed_input = seed_input.read_text() if seed_input.exists() else None
            result.remote_runner = (remote / 'deploy/ec2/server/ec2-seed-demo.sh').read_text() if execute_remote else None
            result.remote_preset = (remote / 'commerce-demo/grocery/preset.json').read_bytes() if (remote / 'commerce-demo/grocery/preset.json').exists() else None
            return result, calls

    def test_default_and_each_store_are_routed_without_deployment(self):
        for store in ('all', 'grocery', 'jewelry', 'electronics', 'pharmacy'):
            with self.subTest(store=store):
                result, calls = self.run_launcher([] if store == 'all' else ['--store', store])
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(len(calls), 1)
                self.assertIn(f"sudo -n bash '/opt/rocento/deploy/ec2/server/ec2-seed-demo.sh' --store '{store}'", calls[0][-1])
                self.assertNotIn('ec2-up.sh', calls[0][-1])
                self.assertIn('ubuntu@3.78.102.161', calls[0])
                self.assertIn('--delivery-areas-stdin', calls[0][-1])
                expected = {*SEED_FILES, 'commerce-demo/egypt-delivery-areas.json'}
                if store in ('all', 'grocery'):
                    expected.update(('commerce-demo/grocery/preset.json', 'commerce-demo/grocery/theme.json'))
                    expected.update(str(p.relative_to(ROOT)) for p in (ROOT / 'commerce-assets/demo/Grocery-Items').rglob('*') if p.is_file())
                if store in ('all', 'pharmacy'):
                    expected.update(('commerce-demo/pharmacy/preset.json', 'commerce-demo/pharmacy/theme.json'))
                    expected.update(str(p.relative_to(ROOT)) for p in (ROOT / 'commerce-assets/demo/pharmacy').rglob('*') if p.is_file())
                self.assertEqual(set(result.uploaded), expected)
                self.assertTrue(all(not headers for headers in result.archive_headers.values()))
                for name, content in result.uploaded.items():
                    self.assertEqual(content, (ROOT / name).read_bytes())

    def test_delivery_only_uploads_no_catalog_and_routes_expansion(self):
        result, calls = self.run_launcher(['--store', 'all', '--delivery-only', '--expand-coverage'], execute_remote=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.seed_args, ['--store', 'all', '--delivery-areas-stdin', '--delivery-only', '--expand-coverage'])
        self.assertEqual(set(result.uploaded), {*SEED_FILES, 'commerce-demo/egypt-delivery-areas.json'})
        self.assertIsNone(result.remote_preset)
        self.assertEqual(len(calls), 1)

    def test_stale_remote_runner_is_updated_before_seeding(self):
        result, calls = self.run_launcher(['--store', 'electronics'], execute_remote=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 1)
        self.assertEqual(result.seed_args, ['--store', 'electronics', '--delivery-areas-stdin'])
        self.assertEqual(result.seed_input, (ROOT / 'commerce-demo/egypt-delivery-areas.json').read_text())
        self.assertEqual(result.remote_runner.encode(), result.uploaded['commerce-ops/deploy/ec2/server/ec2-seed-demo.sh'])

    def test_grocery_preset_and_images_are_installed_without_deployment(self):
        result, calls = self.run_launcher(['--store', 'grocery'], execute_remote=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.remote_preset, (ROOT / 'commerce-demo/grocery/preset.json').read_bytes())
        self.assertEqual(result.seed_args, ['--store', 'grocery', '--delivery-areas-stdin'])

    def test_active_deployment_blocks_helper_updates_and_seed(self):
        result, calls = self.run_launcher([], execute_remote=True, locked=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Another deployment or seed is active', result.stderr)
        self.assertIn('Unknown option', result.remote_runner)
        self.assertIsNone(result.seed_args)

    def test_remote_seed_failure_is_propagated_without_retry(self):
        result, calls = self.run_launcher([], execute_remote=True, seed_exit=23)
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertEqual(len(calls), 1)
        self.assertIn('No automatic retry', result.stderr)

    def test_failure_is_propagated_without_retry(self):
        result, calls = self.run_launcher(['--store', 'grocery'], 255)
        self.assertEqual(result.returncode, 255)
        self.assertEqual(len(calls), 1)
        self.assertIn('No automatic retry', result.stderr)

    def test_invalid_options_never_connect(self):
        for args in (['--store'], ['--store', 'grocery;bad'], ['--deploy'], ['--expand-coverage']):
            result, calls = self.run_launcher(args)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(calls, [])

    def test_help_and_shell_syntax(self):
        subprocess.run(['bash', '-n', str(ROOT / 'commerce-ops/deploy/aws-deploy/seed-demo.sh')], check=True)
        result, calls = self.run_launcher(['--help'])
        self.assertEqual(result.returncode, 0)
        self.assertIn('--store', result.stdout)
        self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
