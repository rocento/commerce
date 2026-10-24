"""Target configuration is data, with explicit overrides and strict fields."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
LOADER = ROOT / 'commerce-ops/cloud/providers/gcp/target.sh'

class GcpTargetTests(unittest.TestCase):
    def test_launchers_load_targets_from_an_unrelated_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'checkout with spaces'
            provider = root / 'commerce-ops/cloud/providers/gcp'
            provider.mkdir(parents=True)
            for name in ('target.sh', 'deploy.sh', 'seed-demo.sh'):
                shutil.copy2(LOADER.parent / name, provider / name)
            config = root / '.local/commerce-ops/targets/production-gcp.env'
            config.parent.mkdir(parents=True)
            config.write_text('PROVIDER=gcp\nHOST=203.0.113.10\nSSH_KEY=keys/test key\n')
            # Replace the write-capable workflow with an argument recorder.
            (root / 'commerce-ops/cloud/seed-demo.sh').write_text(
                '#!/bin/bash\nprintf "%s\\n" "$@"\n')
            env = {key: value for key, value in os.environ.items()
                   if not key.startswith('GCLOUD_') and key != 'ROCENTO_TARGET_RESOLVED'}
            for host_args, expected in (([], '203.0.113.10'),
                                        (['--host', '203.0.113.20'], '203.0.113.20')):
                result = subprocess.run(
                    ['bash', str(provider / 'seed-demo.sh'), *host_args, '--store', 'grocery'],
                    cwd=directory, env=env, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.splitlines(), [
                    '--provider', 'gcp', '--host', expected,
                    '--key', str(root / 'keys/test key'), '--store', 'grocery'])
            result = subprocess.run(['bash', str(provider / 'deploy.sh'), '--help'],
                                    cwd=directory, env=env, capture_output=True,
                                    text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('Usage:', result.stdout)
            config.write_text('PROVIDER=aws\n')
            for name in ('deploy.sh', 'seed-demo.sh'):
                result = subprocess.run(['bash', str(provider / name)], cwd=directory,
                                        env=env, capture_output=True, text=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('PROVIDER=gcp', result.stderr)

    def load(self, contents, host='', symlink=False):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'target.env'
            config.write_text(contents)
            if symlink:
                link = Path(directory) / 'alias.env'
                link.symlink_to(config)
                config = link
            return subprocess.run(['bash', '-c',
                'set -eu; fail() { echo "$*" >&2; exit 1; }; '
                'CONFIG=$1; HOST=$3; SSH_KEY=; PROJECT=; ZONE=; INSTANCE=; '
                '. "$2"; load_gcp_target; printf "%s\\n" "$HOST" "$SSH_KEY"',
                'target-test', str(config), str(LOADER), host],
                capture_output=True, text=True, cwd=directory)

    def test_file_defaults_and_environment_precedence(self):
        contents = 'PROVIDER=gcp\nHOST=203.0.113.10\nSSH_KEY=keys/test key'
        result = self.load(contents)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), ['203.0.113.10', 'keys/test key'])
        result = self.load(contents, host='203.0.113.20')
        self.assertEqual(result.stdout.splitlines()[0], '203.0.113.20')

    def test_rejects_invalid_configuration(self):
        for contents in ('HOST=203.0.113.10', 'PROVIDER=aws',
                         'PROVIDER=gcp\nPROVIDER=gcp', 'PROVIDER=gcp\nSSH_USER=root',
                         'PROVIDER=gcp\nHOST=x\nHOST=y', 'PROVIDER=gcp\nUNKNOWN=value',
                         'PROVIDER=gcp\nHOST= x', 'PROVIDER=gcp\nHOST=', 'not-an-assignment'):
            with self.subTest(contents=contents):
                self.assertNotEqual(self.load(contents).returncode, 0)
        self.assertNotEqual(self.load('PROVIDER=gcp', symlink=True).returncode, 0)

    def test_shell_expressions_remain_literal(self):
        result = self.load('PROVIDER=gcp\nHOST=$(exit 91)\nSSH_KEY=`exit 92`')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), ['$(exit 91)', '`exit 92`'])
