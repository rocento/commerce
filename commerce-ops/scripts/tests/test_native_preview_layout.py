"""Verify controller relocation and standalone installation without host or AWS access."""
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[3]
CANONICAL = ROOT / 'commerce-ops/deploy/aws-automation'
PACKAGE_FILES = (
    'controller.py', 'install-services.sh', 'requirements.txt',
    'iam-policy.json', 'iam-trust.json', 'nginx-apps.conf', 'nginx-native.conf',
    '.env.example', '.gitignore', 'activate.py', 'test_controller.py', 'README.md',
)


class NativePreviewLayoutTests(unittest.TestCase):
    def test_no_root_aws_folders_remain(self):
        self.assertFalse((ROOT / 'aws-deploy').exists())
        self.assertFalse((ROOT / 'aws-automaition').exists())

    def test_controller_import_uses_canonical_implementation(self):
        module = runpy.run_path(str(CANONICAL / 'controller.py'), run_name='compatibility_controller')
        control_type = module['Control']
        self.assertEqual(Path(control_type.action.__code__.co_filename), CANONICAL / 'controller.py')
        ec2 = Mock()
        ec2.describe_instances.return_value = {
            'Reservations': [{'Instances': [{'State': {'Name': 'stopped'}}]}],
        }
        control = control_type(ec2, 'i-0af639278db7286a9', 'test-token-' * 4)
        self.assertEqual(control.action('start')[1]['state'], 'pending')
        ec2.start_instances.assert_called_once_with(InstanceIds=['i-0af639278db7286a9'])

    def test_controller_discovery_works_from_another_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            for source in (CANONICAL,):
                with self.subTest(source=source):
                    result = subprocess.run(
                        [sys.executable, '-m', 'unittest', 'discover', '-s', str(source), '-p', 'test_*.py'],
                        cwd=directory, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'},
                        capture_output=True, text=True, timeout=15,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn('Ran 15 tests', result.stderr)
                    self.assertIn('OK', result.stderr)

    def test_controller_folder_installs_alone(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            # A standalone upload deliberately has no repository parents or old source folder.
            package = base / 'uploaded controller'
            package.mkdir(parents=True)
            for name in PACKAGE_FILES:
                shutil.copy2(CANONICAL / name, package / name)
            runtime, units, bin_dir = (base / name for name in ('runtime', 'units', 'bin'))
            for folder in (runtime, units, bin_dir):
                folder.mkdir()
            token = 'fixture-only-token-' * 3
            environment = runtime / 'controller.env'
            environment.write_text(f'MOBILE_ANDROID_PREVIEW_WORKER_TOKEN={token}\nEXISTING_SETTING=keep\n')
            (runtime / 'tunnel-key').write_text('fixture only')
            (runtime / 'gateway.env').write_text('keep this fixture')
            installer = package / 'install-services.sh'
            text = installer.read_text()
            # Redirect only fixed host paths in this isolated test copy; production defaults stay fixed.
            self.assertIn('root=/opt/rocento-preview-control\n', text)
            self.assertNotIn('activate.py', text)
            text = text.replace('/opt/rocento-preview-control', str(runtime))
            text = text.replace('/etc/systemd/system/', str(units) + '/')
            installer.write_text(text)
            systemctl = bin_dir / 'systemctl'
            systemctl.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$SYSTEMCTL_TEST_LOG"\n')
            systemctl.chmod(0o755)
            command = installer
            log = base / 'systemctl.log'
            env = {**os.environ, 'PATH': str(bin_dir) + os.pathsep + os.environ['PATH'],
                   'SYSTEMCTL_TEST_LOG': str(log), 'PYTHONDONTWRITEBYTECODE': '1'}
            for _ in range(2):
                result = subprocess.run(['sh', str(command)], cwd=base, env=env,
                                        capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn(token, result.stdout + result.stderr)
            self.assertEqual((runtime / 'controller.py').read_bytes(), (CANONICAL / 'controller.py').read_bytes())
            self.assertEqual(environment.stat().st_mode & 0o777, 0o600)
            self.assertEqual((runtime / 'controller.py').stat().st_mode & 0o777, 0o600)
            values = dict(line.split('=', 1) for line in environment.read_text().splitlines())
            self.assertEqual(values['MOBILE_ANDROID_PREVIEW_WORKER_TOKEN'], token)
            self.assertEqual(values['EXISTING_SETTING'], 'keep')
            self.assertEqual(values['ANDROID_EC2_INSTANCE_ID'], 'i-0af639278db7286a9')
            self.assertEqual(values['AWS_REGION'], 'eu-central-1')
            self.assertEqual((runtime / 'tunnel-key').read_text(), 'fixture only')
            self.assertEqual((runtime / 'gateway.env').read_text(), 'keep this fixture')
            self.assertEqual(log.read_text().splitlines(), [
                'daemon-reload', 'enable --now rocento-android-tunnel rocento-android-controller',
            ] * 2)
            service = (units / 'rocento-android-controller.service').read_text()
            self.assertIn(f'ExecStart={runtime}/venv/bin/python {runtime}/controller.py', service)
            self.assertIn(f'EnvironmentFile={runtime}/controller.env', service)
            self.assertEqual({path.name for path in units.iterdir()}, {
                'rocento-android-controller.service', 'rocento-android-tunnel.service',
            })
            # Both IAM documents and proxy snippets travel with this independently uploadable folder.
            policy = json.loads((package / 'iam-policy.json').read_text())
            scope = policy['Statement'][1]
            self.assertEqual(scope['Action'], ['ec2:StartInstances', 'ec2:StopInstances'])
            self.assertEqual(scope['Resource'], 'arn:aws:ec2:eu-central-1:879381261006:instance/i-0af639278db7286a9')


if __name__ == '__main__':
    unittest.main()
