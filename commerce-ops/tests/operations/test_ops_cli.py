"""Offline routing checks for the public commerce-ops dispatcher."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]


class OpsCLITests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.ops = self.root / 'commerce-ops/bin/ops'
        self.ops.parent.mkdir(parents=True)
        shutil.copy2(ROOT / 'commerce-ops/bin/ops', self.ops)
        shutil.copy2(ROOT / 'commerce-ops/commands.json', self.root / 'commerce-ops/commands.json')
        target_module = self.root / 'commerce-ops/cloud/lib/targets.py'
        target_module.parent.mkdir(parents=True)
        shutil.copy2(ROOT / 'commerce-ops/cloud/lib/targets.py', target_module)
        self.calls = self.root / 'calls.txt'
        self.env = {**os.environ, 'OPS_CALLS': str(self.calls)}

    def run_ops(self, *args, cwd=None, env=None):
        return subprocess.run([sys.executable, str(self.ops), *args], cwd=cwd or self.root,
                              env=env or self.env, capture_output=True, text=True, timeout=10)

    def target(self, name, contents):
        file = self.root / '.local/commerce-ops/targets' / f'{name}.env'
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(contents)
        return file

    def shell_stub(self, relative, body):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('#!/usr/bin/env bash\nset -eu\n' + body)
        return path

    def fake_command(self, name):
        binary = self.root / 'bin' / name
        binary.parent.mkdir(parents=True, exist_ok=True)
        binary.write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
Path(os.environ['OPS_CALLS']).write_text(json.dumps({'command': sys.argv[0], 'args': sys.argv[1:], 'cwd': os.getcwd()}))
''')
        binary.chmod(0o755)
        self.env['PATH'] = str(binary.parent) + os.pathsep + os.environ['PATH']

    def test_help_and_catalog_work_from_another_directory_without_configuration(self):
        with tempfile.TemporaryDirectory() as elsewhere:
            help_result = self.run_ops('help', cwd=elsewhere)
            catalog = self.run_ops('catalog', cwd=elsewhere)
        self.assertEqual(help_result.returncode, 0, help_result.stderr)
        self.assertIn('local', help_result.stdout)
        self.assertEqual(catalog.returncode, 0, catalog.stderr)
        self.assertIn('cloud deploy', catalog.stdout)
        self.assertIn('remote-write', catalog.stdout)
        self.assertFalse(self.calls.exists())

    def test_local_compose_routes_without_cloud_target(self):
        self.shell_stub('commerce-ops/local/platform/local-compose.sh',
                        'printf "%s\\n" "$PWD" "$@" > "$OPS_CALLS"\n')
        result = self.run_ops('local', 'platform', 'up', '--assistant', cwd=Path('/tmp'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls.read_text().splitlines(),
                         [str(self.root), '--assistant', 'up', '-d', '--build', '--wait'])
        self.fake_command('docker')
        (self.root / 'commerce-api/onboard-api').mkdir(parents=True)
        result = self.run_ops('local', 'onboarding', 'status')
        self.assertEqual(result.returncode, 0, result.stderr)
        call = json.loads(self.calls.read_text())
        self.assertEqual(call['cwd'], str(self.root / 'commerce-api/onboard-api'))
        self.assertEqual(call['args'][-1], 'ps')
        self.assertIn(str(self.root / 'commerce-ops/local/onboarding/compose.yaml'), call['args'])

    def test_release_command_preserves_candidate_and_packet_arguments(self):
        script = self.root / 'commerce-ops/workflows/release/release_readiness.py'
        script.parent.mkdir(parents=True)
        script.write_text('''import json, os, sys
from pathlib import Path
Path(os.environ['OPS_CALLS']).write_text(json.dumps(sys.argv[1:]))
''')
        digest = 'a' * 64
        result = self.run_ops('release', 'prepare', '--candidate', digest,
                              '--packet', 'commerce-output/release/packet.json',
                              '--environment', 'production', '--owner', 'operator')
        self.assertEqual(result.returncode, 0, result.stderr)
        call = json.loads(self.calls.read_text())
        self.assertEqual(call[0], 'init')
        self.assertIn(digest, call)
        self.assertIn('operator', call)
        self.assertIn('commerce-output/release/packet.json', call)

    def test_plan_is_offline_and_host_precedence_is_explicit(self):
        self.target('production-aws', 'PROVIDER=aws\nHOST=203.0.113.10\nSSH_USER=ubuntu\n')
        packet = self.root / 'commerce-output/release/packet.json'
        packet.parent.mkdir(parents=True)
        packet.write_text('{}')
        self.fake_command('ssh')
        env = {**self.env, 'ROCENTO_AWS_HOST': '203.0.113.11'}
        result = self.run_ops('cloud', 'plan', '--target', 'production-aws', '--host', '203.0.113.12',
                              '--candidate', 'b' * 64, '--packet', 'commerce-output/release/packet.json',
                              cwd=Path('/tmp'), env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('203.0.113.12', result.stdout)
        self.assertIn('read-only offline plan', result.stdout)
        self.assertFalse(self.calls.exists())

    def test_normalized_targets_resolve_for_both_providers(self):
        packet = self.root / 'commerce-output/release/packet.json'
        packet.parent.mkdir(parents=True)
        packet.write_text('{}')
        self.target('production-aws', 'PROVIDER=aws\nHOST=203.0.113.30\n')
        self.target('production-gcp', 'PROVIDER=gcp\nHOST=203.0.113.40\nSSH_KEY=/tmp/fixture-key\n')
        for name, host in (('production-aws', '203.0.113.30'),
                           ('production-gcp', '203.0.113.40')):
            with self.subTest(target=name):
                result = self.run_ops('cloud', 'plan', '--target', name,
                                      '--candidate', 'c' * 64,
                                      '--packet', 'commerce-output/release/packet.json')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(host, result.stdout)
                self.assertIn('.local/commerce-ops/targets/', result.stdout)
        self.assertFalse(self.calls.exists())

    def test_local_demo_requires_explicit_loopback_for_writes(self):
        script = self.root / 'commerce-ops/workflows/demo/seed-demo-storefront.py'
        script.parent.mkdir(parents=True)
        script.write_text('''import json, os, sys
from pathlib import Path
Path(os.environ['OPS_CALLS']).write_text(json.dumps(sys.argv[1:]))
''')
        preview = self.run_ops('local', 'demo', 'seed', '--store', 'grocery')
        self.assertEqual(preview.returncode, 0, preview.stderr)
        self.assertEqual(json.loads(self.calls.read_text()), ['grocery'])
        self.calls.unlink()
        remote = self.run_ops('local', 'demo', 'seed', '--store', 'grocery',
                              '--apply', '--api-base', 'https://example.com/api')
        self.assertEqual(remote.returncode, 2)
        self.assertFalse(self.calls.exists())
        local = self.run_ops('local', 'demo', 'seed', '--store', 'grocery',
                             '--apply', '--api-base', 'http://127.0.0.1:5274/api')
        self.assertEqual(local.returncode, 0, local.stderr)
        self.assertEqual(json.loads(self.calls.read_text()),
                         ['grocery', '--apply', '--api-base', 'http://127.0.0.1:5274/api'])

    def test_cloud_deploy_routes_to_provider_launcher_without_network(self):
        self.target('production-aws', 'PROVIDER=aws\nHOST=203.0.113.10\n')
        self.target('production-gcp', 'PROVIDER=gcp\nHOST=203.0.113.20\nSSH_KEY=/tmp/fixture-key\n')
        self.shell_stub('commerce-ops/cloud/providers/aws/deploy.sh',
                        'printf "%s\\n" "$ROCENTO_AWS_HOST" "$@" > "$OPS_CALLS"\n')
        self.shell_stub('commerce-ops/cloud/providers/gcp/deploy.sh',
                        'printf "%s\\n" "$GCLOUD_HOST" "$GCLOUD_SSH_KEY" "$ROCENTO_TARGET_RESOLVED" "$@" > "$OPS_CALLS"\n')
        aws = self.run_ops('cloud', 'deploy', '--target', 'production-aws', '--preserve-ai')
        self.assertEqual(aws.returncode, 0, aws.stderr)
        self.assertEqual(self.calls.read_text().splitlines(), ['203.0.113.10', '--preserve-ai'])
        gcp = self.run_ops('cloud', 'deploy', '--target', 'production-gcp')
        self.assertEqual(gcp.returncode, 0, gcp.stderr)
        self.assertEqual(self.calls.read_text().splitlines(),
                         ['203.0.113.20', '/tmp/fixture-key', '1'])

    def test_diagnostics_use_installed_paths_and_reject_unsafe_service(self):
        self.target('production-aws', 'PROVIDER=aws\nHOST=203.0.113.10\n')
        key = self.root / '.local/commerce-ops/secrets/aws/rocento.pem'
        key.parent.mkdir(parents=True)
        key.write_text('fixture only')
        self.fake_command('ssh')
        result = self.run_ops('cloud', 'logs', '--target', 'production-aws',
                              '--store', 'grocery', '--service', 'api-gateway', '--tail', '25')
        self.assertEqual(result.returncode, 0, result.stderr)
        call = json.loads(self.calls.read_text())
        self.assertIn('/opt/rocento/deploy/ec2/server/ec2-compose.sh grocery logs --tail=25 api-gateway', call['args'][-1])
        self.calls.unlink()
        bad = self.run_ops('cloud', 'logs', '--target', 'production-aws',
                           '--store', 'grocery', '--service', 'api-gateway;touch /tmp/surprise')
        self.assertNotEqual(bad.returncode, 0)
        self.assertFalse(self.calls.exists())

    def test_cloud_demo_seed_is_separate_and_routes_to_both_providers(self):
        self.target('production-aws', 'PROVIDER=aws\nHOST=203.0.113.10\n')
        self.target('production-gcp', 'PROVIDER=gcp\nHOST=203.0.113.20\n')
        self.shell_stub('commerce-ops/cloud/providers/aws/seed-demo.sh',
                        'printf "%s\\n" "$ROCENTO_AWS_HOST" "$@" > "$OPS_CALLS"\n')
        self.shell_stub('commerce-ops/cloud/providers/gcp/seed-demo.sh',
                        'printf "%s\\n" "$GCLOUD_HOST" "$@" > "$OPS_CALLS"\n')
        result = self.run_ops('cloud', 'demo', 'seed', '--target', 'production-aws',
                              '--store', 'grocery', '--delivery-only')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls.read_text().splitlines(),
                         ['203.0.113.10', '--store', 'grocery', '--delivery-only'])
        self.calls.unlink()
        gcp = self.run_ops('cloud', 'demo', 'seed', '--target', 'production-gcp',
                           '--store', 'grocery')
        self.assertEqual(gcp.returncode, 0, gcp.stderr)
        self.assertEqual(self.calls.read_text().splitlines(),
                         ['203.0.113.20', '--store', 'grocery'])

    def test_invalid_target_and_missing_explicit_target_stop_before_routing(self):
        self.target('production-aws', 'PROVIDER=aws\nHOST=203.0.113.10\nHOST=203.0.113.11\n')
        duplicate = self.run_ops('cloud', 'deploy', '--target', 'production-aws')
        self.assertEqual(duplicate.returncode, 2)
        self.assertIn('duplicate', duplicate.stderr)
        missing = self.run_ops('cloud', 'deploy')
        self.assertNotEqual(missing.returncode, 0)
        self.assertFalse(self.calls.exists())


if __name__ == '__main__':
    unittest.main()
