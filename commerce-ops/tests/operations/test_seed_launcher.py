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
SEED_FILES = ('commerce-ops/deploy/ec2/server/ec2-seed-demo.sh', 'commerce-ops/deploy/ec2/server/repository-root.sh',
              'commerce-ops/cloud/host/seed-demo.sh',
              'commerce-ops/cloud/host/bootstrap.sh',
              'commerce-ops/workflows/demo/seed-demo-storefront.py', 'commerce-ops/workflows/demo/demo_presets.py',
              'commerce-ops/workflows/demo/sync-grocery-palette.py', 'commerce-ops/workflows/demo/grocery_palette.py',
              'commerce-assets/demo/demo_seed.py', 'commerce-assets/demo/seed-category-images.py', 'commerce-assets/demo/seed-delivery-areas.py')


class SeedLauncherTests(unittest.TestCase):
    def run_launcher(self, args, exit_code=0, execute_remote=False, locked=False, seed_exit=0):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            deploy = root / 'commerce-ops/deploy/aws-deploy'
            deploy.mkdir(parents=True)
            provider = root / 'commerce-ops/cloud/providers/aws'
            provider.mkdir(parents=True)
            shared_cloud = root / 'commerce-ops/cloud'
            shutil.copy2(ROOT / 'commerce-ops/cloud/seed-demo.sh', shared_cloud / 'seed-demo.sh')
            shutil.copy2(ROOT / 'commerce-ops/cloud/providers/aws/seed-demo.sh', provider / 'seed-demo.sh')
            shutil.copy2(ROOT / 'commerce-ops/cloud/providers/aws/target.sh', provider / 'target.sh')
            key = root / '.local/commerce-ops/secrets/aws/rocento.pem'
            key.parent.mkdir(parents=True)
            key.write_text('test placeholder')
            (root / 'commerce-demo').mkdir()
            shutil.copy2(ROOT / 'commerce-demo/egypt-delivery-areas.json', root / 'commerce-demo/egypt-delivery-areas.json')
            for name in SEED_FILES:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / name, target)
            for store in ('grocery', 'jewelry', 'electronics', 'pharmacy'):
                shutil.copytree(ROOT / 'commerce-demo' / store, root / 'commerce-demo' / store)
            for directory in ('Grocery-Items', 'jewelry', 'electronics', 'pharmacy', 'categories'):
                shutil.copytree(ROOT / 'commerce-assets/demo' / directory, root / 'commerce-assets/demo' / directory)
            remote = root / 'remote'
            if execute_remote:
                for name in ('deploy/ec2/server', 'commerce-assets/demo', 'commerce-demo'):
                    (remote / name).mkdir(parents=True)
                (remote / 'deploy/ec2/server/ec2-bootstrap.sh').touch()
                (remote / 'deploy/ec2/server/ec2-seed-demo.sh').write_text('echo "ERROR: Unknown option: --delivery-areas-stdin" >&2; exit 1\n')
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
            for name, script in {'sudo': '''#!/bin/bash
shift
if [[ $1 == bash && $2 == */deploy/ec2/server/ec2-seed-demo.sh ]]; then
  shift 2
  printf '%s\\n' "$@" > "$FAKE_SEED_ARGS"
  cat > "$FAKE_SEED_INPUT"
  exit "$FAKE_SEED_EXIT"
fi
exec "$@"
''',
                                 'install': '''#!/bin/bash
if [[ $1 == -D ]]; then
  shift
  mkdir -p "$(dirname "${@: -1}")"
fi
exec /usr/bin/install "$@"
''',
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
                   'FAKE_SEED_INPUT': str(seed_input), 'FAKE_SEED_EXIT': str(seed_exit),
                   'ROCENTO_AWS_HOST': '198.51.100.10'}
            result = subprocess.run(['bash', str(provider / 'seed-demo.sh'), *args], env=env, capture_output=True, text=True, timeout=10)
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
                self.assertIn('ubuntu@198.51.100.10', calls[0])
                self.assertIn('--delivery-areas-stdin', calls[0][-1])
                expected = {*SEED_FILES, 'commerce-demo/egypt-delivery-areas.json'}
                if store in ('all', 'grocery'):
                    expected.update(('commerce-demo/grocery/preset.json', 'commerce-demo/grocery/theme.json'))
                    expected.update(str(p.relative_to(ROOT)) for p in (ROOT / 'commerce-assets/demo/Grocery-Items').rglob('*') if p.is_file())
                if store in ('all', 'pharmacy'):
                    expected.update(('commerce-demo/pharmacy/preset.json', 'commerce-demo/pharmacy/theme.json'))
                    expected.update(str(p.relative_to(ROOT)) for p in (ROOT / 'commerce-assets/demo/pharmacy').rglob('*') if p.is_file())
                for selected in ('jewelry', 'electronics'):
                    if store in ('all', selected):
                        expected.update((f'commerce-demo/{selected}/preset.json', f'commerce-demo/{selected}/theme.json'))
                        expected.update(str(p.relative_to(ROOT)) for p in (ROOT / 'commerce-assets/demo' / selected).rglob('*') if p.is_file())
                if store in ('all', 'jewelry'):
                    expected.update(str(p.relative_to(ROOT)) for p in (ROOT / 'commerce-assets/demo/categories').rglob('*') if p.is_file())
                self.assertEqual(set(result.uploaded), expected)
                self.assertTrue(all(not headers for headers in result.archive_headers.values()))
                for name, content in result.uploaded.items():
                    self.assertEqual(content, (ROOT / name).read_bytes())

    def test_delivery_only_routes_expansion_without_catalog_validation(self):
        result, calls = self.run_launcher(['--store', 'all', '--delivery-only', '--expand-coverage'], execute_remote=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.seed_args, ['--store', 'all', '--delivery-areas-stdin', '--delivery-only', '--expand-coverage'])
        expected = {*SEED_FILES, 'commerce-demo/egypt-delivery-areas.json'}
        for store in ('grocery', 'jewelry', 'electronics', 'pharmacy'):
            expected.update((f'commerce-demo/{store}/preset.json', f'commerce-demo/{store}/theme.json'))
            assets = 'Grocery-Items' if store == 'grocery' else store
            expected.update(str(p.relative_to(ROOT)) for p in (ROOT / 'commerce-assets/demo' / assets).rglob('*') if p.is_file())
        self.assertEqual(set(result.uploaded), expected)
        self.assertEqual(result.remote_preset, (ROOT / 'commerce-demo/grocery/preset.json').read_bytes())
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
        subprocess.run(['bash', '-n', str(ROOT / 'commerce-ops/cloud/providers/aws/seed-demo.sh')], check=True)
        result, calls = self.run_launcher(['--help'])
        self.assertEqual(result.returncode, 0)
        self.assertIn('--store', result.stdout)
        self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
