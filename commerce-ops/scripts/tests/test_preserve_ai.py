import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('preserve_ai', ROOT / 'commerce-ops/deploy/ec2/server/ec2-preserve-ai.py')
preserve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preserve)


class PreserveAITests(unittest.TestCase):
    def setUp(self):
        self.containers = {}
        for store in preserve.STORES:
            for service in ('ai-service', 'commerce-language-engine', 'assistant-ingress', 'api-gateway'):
                identifier = f'{store}-{service}'
                self.containers[identifier] = {
                    'Id': identifier, 'Image': 'sha256:' + service,
                    'State': {'Running': True, 'Health': {'Status': 'healthy'}},
                    'Config': {'Labels': {'com.docker.compose.service': service}},
                }
        self.provenance = {'releaseId': 'production-release', 'runtimeVersion': 'verified-runtime',
                           'generationFingerprint': 'verified-dictionary'}

    def command(self, *args):
        if args[:2] == ('docker', 'ps'):
            project = next((arg.split('=rocento-', 1)[1] for arg in args if '=rocento-' in arg), None)
            return '\n'.join(k for k in self.containers if project and k.startswith(project + '-'))
        if args[:2] == ('docker', 'inspect'):
            return json.dumps([self.containers[args[2]]])
        if args[:2] == ('docker', 'exec'):
            if args[3] == 'node':
                return json.dumps({'status': 'ok', 'provenance': self.provenance})
            return json.dumps({'status': 'ready', 'components': {'language': 'ready', 'storage': 'ready'}})
        raise AssertionError(args)

    def test_snapshot_records_only_protected_running_services_and_release_identity(self):
        with patch.object(preserve, 'command', side_effect=self.command):
            result = preserve.capture()
        self.assertEqual(set(result), set(preserve.STORES))
        self.assertNotIn('api-gateway', result['grocery']['services'])
        self.assertEqual(result['grocery']['provenance'], self.provenance)
        self.assertEqual(set(result['grocery']['services']['ai-service']), {'container', 'image'})

    def test_health_missing_containers_and_missing_release_identity_fail_closed(self):
        for failure in ('unhealthy', 'missing', 'provenance'):
            with self.subTest(failure=failure):
                original = copy.deepcopy(self.containers)
                identity = self.provenance
                if failure == 'unhealthy':
                    self.containers['grocery-ai-service']['State']['Health']['Status'] = 'unhealthy'
                elif failure == 'missing':
                    del self.containers['grocery-commerce-language-engine']
                else:
                    self.provenance = {}
                with patch.object(preserve, 'command', side_effect=self.command), self.assertRaises(ValueError):
                    preserve.capture()
                self.containers = original
                self.provenance = identity

    def test_verification_detects_image_or_release_replacement(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(preserve, 'command', side_effect=self.command):
            path = Path(directory) / 'baseline.json'
            path.write_text(json.dumps(preserve.capture()))
            preserve.verify(path)
            self.containers['grocery-ai-service']['Image'] = 'candidate-image'
            with self.assertRaisesRegex(ValueError, 'identity changed'):
                preserve.verify(path)
            self.containers['grocery-ai-service']['Image'] = 'sha256:ai-service'
            self.provenance['releaseId'] = 'candidate-release'
            with self.assertRaisesRegex(ValueError, 'identity changed'):
                preserve.verify(path)

    def test_preserved_deployment_promotes_only_reviewed_commerce_services(self):
        source = (ROOT / 'commerce-ops/deploy/ec2/server/ec2-up.sh').read_text()
        function = 'start_store_preserving_ai() {' + source.split('start_store_preserving_ai() {', 1)[1].split('\nstart_store()', 1)[0]
        harness = '''
ROOT=/release
BUILD=auto
RELEASE_ARGS=(--fixture)
ROCENTO_AI_BASELINE=/baseline.json
backend_fingerprint() { echo candidate; }
state_value() { echo previous; }
state_set() { echo "state $*"; }
engagement_import_state() { echo complete; }
fail() { echo "$*" >&2; exit 1; }
ok() { :; }
python3() { echo sha256:running-python; }
docker() { echo "docker $*"; }
compose() { echo "compose $*"; }
for store in grocery jewelry electronics pharmacy; do start_store_preserving_ai "$store"; done
'''
        result = subprocess.run(['bash', '-eu', '-c', function + harness], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.count('docker build -t rocento-backend:release'), 0)
        self.assertEqual(result.stdout.count('--installed-contracts-only /app/app'), 4)
        for line in result.stdout.splitlines():
            if line.startswith('compose '):
                self.assertIn('--no-deps', line)
                for protected in preserve.SERVICES:
                    self.assertNotIn(protected, line.split())
        self.assertNotIn('conversations-setup', result.stdout)
        self.assertNotIn('backend.sha256', result.stdout)
        self.assertIn('preserved-commerce.sha256', result.stdout)


if __name__ == '__main__':
    unittest.main()
