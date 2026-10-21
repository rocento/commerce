"""Exercise relocated deployment entry points without contacting a host."""
from pathlib import Path
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]


class DeploymentLayoutTests(unittest.TestCase):
    def test_no_ec2_forwarding_commands_remain(self):
        self.assertEqual(list((ROOT / 'commerce-ops/scripts').glob('ec2-*')), [])

    def test_help_and_errors_work_from_an_unrelated_working_directory(self):
        commands = [
            ('bash', 'commerce-ops/deploy/aws-deploy/deploy.sh', 'commerce-ops/deploy/aws-deploy/deploy.sh'),
            ('bash', 'commerce-ops/deploy/aws-deploy/deploy-ai.sh', 'commerce-ops/deploy/aws-deploy/deploy-ai.sh'),
            ('bash', 'commerce-ops/deploy/aws-deploy/deploy-rengine.sh', 'commerce-ops/deploy/aws-deploy/deploy-rengine.sh'),
            ('bash', 'commerce-ops/deploy/aws-deploy/seed-demo.sh', 'commerce-ops/deploy/aws-deploy/seed-demo.sh'),
            ('bash', 'commerce-ops/deploy/aws-deploy/assistant-db-tunnel.sh', 'commerce-ops/deploy/aws-deploy/assistant-db-tunnel.sh'),
            ('bash', 'commerce-ops/deploy/ec2/server/ec2-up.sh', 'commerce-ops/deploy/ec2/server/ec2-up.sh'),
            ('bash', 'commerce-ops/deploy/ec2/server/ec2-deploy-ai.sh', 'commerce-ops/deploy/ec2/server/ec2-deploy-ai.sh'),
            ('bash', 'commerce-ops/deploy/ec2/server/ec2-seed-demo.sh', 'commerce-ops/deploy/ec2/server/ec2-seed-demo.sh'),
            (sys.executable, 'commerce-ops/deploy/ec2/server/ec2-check.py', 'commerce-ops/deploy/ec2/server/ec2-check.py'),
            (sys.executable, 'commerce-ops/deploy/ec2/server/ec2-deploy-job.py', 'commerce-ops/deploy/ec2/server/ec2-deploy-job.py'),
            (sys.executable, 'commerce-ops/deploy/ec2/server/ec2-preserve-ai.py', 'commerce-ops/deploy/ec2/server/ec2-preserve-ai.py'),
            (sys.executable, 'commerce-ops/deploy/ec2/server/ec2-publish-website.py', 'commerce-ops/deploy/ec2/server/ec2-publish-website.py'),
        ]
        with tempfile.TemporaryDirectory() as directory:
            for interpreter, old, canonical in commands:
                for argument in ('--help', '--invalid-layout-test-option'):
                    with self.subTest(command=old, argument=argument):
                        results = [subprocess.run(
                            [interpreter, str(ROOT / path), argument], cwd=(ROOT if index == 1 else directory),
                            text=True, capture_output=True, timeout=10,
                        ) for index, path in enumerate((old, canonical))]
                        self.assertEqual(results[0].returncode, results[1].returncode)
                        self.assertEqual(results[0].stdout, results[1].stdout)
                        self.assertEqual(results[0].stderr, results[1].stderr)
                        self.assertEqual(results[0].returncode == 0, argument == '--help')

    def test_sourced_helpers_preserve_caller_functions_and_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run([
                'bash', '-eu', '-c',
                '. "$1"; configure_source_filters; printf "%s\\n" "${SOURCE_FILTERS[@]}"; '
                '. "$2"; declare -F load_bootstrap',
                'layout-check', str(ROOT / 'commerce-ops/deploy/ec2/server/ec2-source-filters.sh'),
                str(ROOT / 'commerce-ops/deploy/ec2/server/ec2-bootstrap.sh'),
            ], cwd=directory, text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('--exclude=/commerce-ops/deploy/aws-deploy/', result.stdout)
            self.assertIn('load_bootstrap', result.stdout)

    def test_rengine_partial_upload_contains_a_runnable_server_entry_point(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            binary = base / 'bin'
            binary.mkdir()
            # Capture the real tar stream while replacing every network command
            # and the source-generating Node command with local fixtures.
            ssh = binary / 'ssh'
            ssh.write_text('#!' + sys.executable + '\n' + '''
import os
from pathlib import Path
import sys
command = sys.argv[-1]
if 'mktemp -d' in command:
    print('/home/ubuntu/.rocento-rengine.ABC12345')
elif 'tar -xzf' in command:
    Path(os.environ['TEST_PACKAGE']).write_bytes(sys.stdin.buffer.read())
''')
            ssh.chmod(0o755)
            node = binary / 'node'
            node.write_text('#!/bin/sh\nexit 0\n')
            node.chmod(0o755)
            archive_path = base / 'upload.tar.gz'
            result = subprocess.run([
                'bash', str(ROOT / 'commerce-ops/deploy/aws-deploy/deploy-rengine.sh'),
            ], cwd=directory, env={**os.environ, 'PATH': str(binary) + os.pathsep + os.environ['PATH'],
                                  'TEST_PACKAGE': str(archive_path)},
                text=True, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            stage = base / 'source'
            with tarfile.open(archive_path) as archive:
                names = set(archive.getnames())
                for name in ('commerce-ops/deploy/ec2/server/ec2-deploy-rengine.sh',):
                    self.assertIn(name, names)
                    destination = stage / name
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(archive.extractfile(name).read())
                self.assertFalse(any(name.startswith(('commerce-ops/deploy/aws-deploy/',)) for name in names))
            staged = subprocess.run([
                'bash', str(stage / 'commerce-ops/deploy/ec2/server/ec2-deploy-rengine.sh'), '--invalid-layout-test-option',
            ], cwd=directory, text=True, capture_output=True, timeout=10)
            self.assertEqual(staged.returncode, 2, staged.stderr)
            self.assertIn('Usage: sudo bash deploy/ec2/server/ec2-deploy-rengine.sh', staged.stderr)


if __name__ == '__main__':
    unittest.main()
