"""Exercise targeted deployment without touching SSH, Docker, or production."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]


class AIDeploymentTests(unittest.TestCase):
    def launch(self, *arguments, remote_failure=False):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            deploy = root / 'commerce-ops/deploy/aws-deploy'
            deploy.mkdir(parents=True)
            shutil.copy2(ROOT / 'commerce-ops/deploy/aws-deploy/deploy-ai.sh', deploy / 'deploy-ai.sh')
            (deploy / 'rocento.pem').write_text('test key placeholder')
            data = root / 'commerce-assistant-platform/app/commerce_language_engine/data'
            data.mkdir(parents=True)
            (data / 'deployment-release.json.gz').write_bytes(b'test bundle placeholder')
            binary = root / 'bin'
            binary.mkdir()
            runner = '''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
name=Path(sys.argv[0]).name
with open(os.environ['CALLS'],'a') as stream:stream.write(json.dumps([name,*sys.argv[1:]])+'\\n')
if name=='ssh' and 'mktemp -d' in sys.argv[-1]:print('/home/ubuntu/.rocento-ai-deploy.ABC12345')
if name=='ssh' and 'sudo bash' in sys.argv[-1] and os.environ['REMOTE_FAILURE']=='1':sys.exit(1)
'''
            for name in ('ssh', 'rsync', 'node'):
                path = binary / name
                path.write_text(runner)
                path.chmod(0o755)
            calls_path = root / 'calls.jsonl'
            result = subprocess.run(
                ['bash', str(deploy / 'deploy-ai.sh'), *arguments],
                env={**os.environ, 'PATH': str(binary) + os.pathsep + os.environ['PATH'],
                     'CALLS': str(calls_path), 'REMOTE_FAILURE': str(int(remote_failure))},
                text=True, capture_output=True, timeout=15,
            )
            calls = [json.loads(line) for line in calls_path.read_text().splitlines()] if calls_path.exists() else []
            return result, calls

    def test_default_uploads_only_both_runtime_contexts(self):
        result, calls = self.launch('--sync-language-data')
        self.assertEqual(result.returncode, 0, result.stderr)
        uploads = [call for call in calls if call[0] == 'rsync']
        self.assertEqual(len(uploads), 2)
        self.assertIn('commerce-assistant-platform/app/', uploads[0])
        self.assertIn('commerce-assistant-platform/knowledge/', uploads[0])
        self.assertIn('commerce-assistant-platform/migrations/', uploads[0])
        self.assertIn('commerce-ops/scripts/conversations-setup.py', uploads[0])
        self.assertIn('commerce-ops/compose/compose.assistant-admin.yaml', uploads[0])
        self.assertIn('commerce-ops/compose/compose.assistant-provider.yaml', uploads[0])
        for name in ('ec2-deploy-ai.sh', 'ec2-compose.sh', 'ec2-shared-ai-upgrade.sh'):
            self.assertIn('commerce-ops/deploy/ec2/server/' + name, uploads[0])
        for name in ('generate_openapi.py', 'generate_assistant_models.py', 'generate_assistant_validator.py'):
            self.assertIn('commerce-ops/scripts/' + name, uploads[0])
            self.assertIn('commerce-ops/scripts/contracts/' + name, uploads[0])
        self.assertIn('--exclude=commerce_language_engine/', uploads[0])
        self.assertIn('commerce-assistant-platform/app/commerce_language_engine/data/compiled.json', uploads[1])
        self.assertIn('commerce-assistant-platform/app/commerce_language_engine/data/deployment-release.json.gz', uploads[1])
        self.assertFalse(any(arg.startswith(('commerce-api/', 'commerce-web/', 'commerce-assets/')) for call in uploads for arg in call))
        commands = [call[-1] for call in calls if call[0] == 'ssh' and 'sudo bash' in call[-1]]
        self.assertEqual(len(commands), 1)
        self.assertIn("--service 'all' --store 'all'", commands[0])
        self.assertNotIn('ec2-up.sh', commands[0])
        self.assertTrue(any(call[0] == 'node' and call[-1].endswith('export-release.ts') for call in calls))

    def test_ai_only_uses_no_node_or_language_upload(self):
        result, calls = self.launch('--service', 'ai', '--store', 'grocery')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(call[0] == 'node' for call in calls))
        self.assertEqual(sum(call[0] == 'rsync' for call in calls), 1)
        self.assertTrue(any("--service 'ai' --store 'grocery'" in call[-1] for call in calls))

    def test_language_only_can_export_local_database(self):
        result, calls = self.launch('--service', 'language', '--sync-language-db')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any('commerce-assistant-platform/app/' in call for call in calls if call[0] == 'rsync'))
        self.assertTrue(any(call[0] == 'node' and call[-1].endswith('export-db-release.ts') for call in calls))

    def test_invalid_scope_stops_before_network_or_export(self):
        for arguments in [('--service', 'ai', '--sync-language-data'), ('--store', 'invalid'), ('--service',), ('--sync-language-data', '--sync-language-db')]:
            with self.subTest(arguments=arguments):
                result, calls = self.launch(*arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls, [])

    def test_remote_failure_is_not_retried_and_upload_is_cleaned(self):
        result, calls = self.launch('--service', 'ai', remote_failure=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(sum(call[0] == 'ssh' and 'sudo bash' in call[-1] for call in calls), 1)
        self.assertTrue(any(call[0] == 'ssh' and "rm -rf -- '/home/ubuntu/.rocento-ai-deploy.ABC12345'" == call[-1] for call in calls))
        self.assertIn('remote-ai-deployment', result.stderr)

    def deploy_store(self, service, failure='', stores=('grocery',)):
        script = (ROOT / 'commerce-ops/deploy/ec2/server/ec2-deploy-ai.sh').read_text()
        function = 'deploy_store() {' + script.split('deploy_store() {', 1)[1].split('\nfor store in "${STORES[@]}"; do deploy_store', 1)[0]
        harness = '''
ROOT=/release
fail() { echo "$*"; exit 1; }
compose() {
  echo "compose $*"
  if [[ -n $FAILURE && $* == *"$FAILURE"* ]]; then return 1; fi
}
python3() {
  echo "python3 $*"
  if [[ -n $FAILURE && $* == *"$FAILURE"* ]]; then return 1; fi
}
''' + function + '\n' + '\n'.join('deploy_store ' + store for store in stores) + '\n'
        return subprocess.run(['bash', '-e', '-c', harness], text=True, capture_output=True,
                              env={**os.environ, 'SERVICE': service, 'FAILURE': failure})

    def test_remote_promotes_only_selected_verified_services(self):
        for service, names in [('all', ['ai-service', 'commerce-language-engine']), ('ai', ['ai-service']), ('language', ['commerce-language-engine'])]:
            with self.subTest(service=service):
                result = self.deploy_store(service)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn(' build ', result.stdout)
                self.assertLess(result.stdout.index('deployment_gate.py artifacts'), result.stdout.index(' up '))
                if service != 'language':
                    self.assertLess(result.stdout.index('conversations-setup.py'), result.stdout.index(' up '))
                else:
                    self.assertNotIn('conversations-setup.py', result.stdout)
                starts = [line for line in result.stdout.splitlines() if ' up ' in line]
                self.assertEqual(len(starts), len(names))
                for line in starts:
                    self.assertIn('--no-deps --no-build --wait', line)
                    self.assertIn(line.split()[-1], names)
                if service == 'all':
                    self.assertTrue(starts[0].endswith('commerce-language-engine'))
                    self.assertTrue(starts[1].endswith('ai-service'))
                if service != 'language':
                    readiness = result.stdout.index('exec -T ai-service python -c ')
                    self.assertLess(result.stdout.index(starts[-1]), readiness)
                    self.assertLess(readiness, result.stdout.index('[OK] grocery'))
                else:
                    self.assertNotIn('http://localhost:8000/ready', result.stdout)

    def test_all_demos_promote_without_rebuilding(self):
        for service in ('all', 'ai', 'language'):
            with self.subTest(service=service):
                result = self.deploy_store(service, stores=('grocery', 'jewelry', 'electronics', 'pharmacy'))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(len([line for line in result.stdout.splitlines() if ' build ' in line]), 0)
                for store in ('grocery', 'jewelry', 'electronics', 'pharmacy'):
                    self.assertIn(f'[OK] {store} {service} assistant deployment healthy', result.stdout)

    def test_artifact_gate_failure_prevents_migration_and_restart(self):
        result = self.deploy_store('all', 'deployment_gate.py artifacts')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(' up ', result.stdout)
        self.assertNotIn('conversations-setup.py', result.stdout)

    def test_preflight_failure_starts_no_services(self):
        result = self.deploy_store('all', 'agentic-preflight.py')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(' up ', result.stdout)

    def test_migration_failure_starts_no_services(self):
        result = self.deploy_store('all', 'conversations-setup.py')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(' up ', result.stdout)

    def test_language_failure_stops_before_ai_restart(self):
        result = self.deploy_store('all', 'up -d --no-deps --no-build --wait --wait-timeout 300 commerce-language-engine')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('logs --tail=60 commerce-language-engine', result.stdout)
        self.assertNotIn('up -d --no-deps --no-build --wait --wait-timeout 300 ai-service', result.stdout)

    def test_ai_readiness_failure_prevents_healthy_result(self):
        for service in ('all', 'ai'):
            with self.subTest(service=service):
                result = self.deploy_store(service, 'http://localhost:8000/ready')
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn('up -d --no-deps --no-build --wait --wait-timeout 300 ai-service', result.stdout)
                self.assertIn('logs --tail=60 ai-service commerce-language-engine', result.stdout)
                self.assertNotIn('[OK]', result.stdout)
                self.assertIn('deployment cannot be marked healthy', result.stdout)


if __name__ == '__main__':
    unittest.main()
