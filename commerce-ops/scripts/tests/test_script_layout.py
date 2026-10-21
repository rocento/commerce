"""Exercise relocated command behavior without accessing services or credentials."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
MANIFEST = json.loads((ROOT / 'commerce-ops/scripts/entrypoints.json').read_text())


class ScriptLayoutTests(unittest.TestCase):
    def run_command(self, command, cwd, **kwargs):
        return subprocess.run(command, cwd=cwd, capture_output=True, text=True,
                              timeout=30, **kwargs)

    def test_canonical_commands_have_help_from_outside_checkout(self):
        names = ('checks/check-documentation.py', 'checks/check_api_documentation.py',
                 'maintenance/inventory-outputs.py', 'evaluation/shopping-evals.py',
                 'evaluation/agent-evals.py', 'release/commerce-release.py',
                 'demo/seed-demo-storefront.py')
        with tempfile.TemporaryDirectory() as outside:
            for name in names:
                path = ROOT / 'commerce-ops/scripts' / name
                with self.subTest(command=name):
                    result = self.run_command([sys.executable, '-B', str(path), '--help'], outside)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn('usage:', result.stdout.lower())

    def test_registered_commands_and_data_exist(self):
        for relative in MANIFEST['commands']:
            with self.subTest(command=relative):
                self.assertTrue((ROOT / relative).is_file())
        for relative in MANIFEST['data']:
            self.assertTrue((ROOT / relative).is_file())

    def test_compose_routes_same_project_and_arguments_from_outside_checkout(self):
        with tempfile.TemporaryDirectory() as directory:
            outside = Path(directory)
            root = outside / 'checkout with spaces'
            for relative in ('commerce-ops/scripts/local/local-compose.sh', 'commerce-ops/scripts/local/local-demo-compose.sh'):
                target = root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / relative, target)
            (root / '.env').touch()
            (root / '.local/assistant').mkdir(parents=True)
            (root / '.local/assistant/local-compose.env').touch()
            (root / '.local/assistant/all-demos-enabled').touch()
            binary = outside / 'bin'
            binary.mkdir()
            docker = binary / 'docker'
            docker.write_text('#!/bin/sh\npwd\nprintf "%s\\n" "$@"\n')
            docker.chmod(0o755)
            env = {**os.environ, 'PATH': str(binary) + os.pathsep + os.environ['PATH']}
            for name, args, project in (
                ('local-compose.sh', ['--assistant', 'config', '--quiet'], 'commerce-ai'),
                ('local-demo-compose.sh', ['grocery', 'config'], 'commerce-ai'),
                ('local-demo-compose.sh', ['jewelry', 'config'], 'commerce-jewelry'),
            ):
                relative = 'commerce-ops/scripts/local/' + name
                result = self.run_command(['bash', str(root / relative), *args], outside, env=env)
                self.assertEqual(result.returncode, 0, result.stderr)
                lines = result.stdout.splitlines()
                self.assertEqual(Path(lines[0]).resolve(), root.resolve())
                self.assertEqual(lines[lines.index('-p') + 1], project)
                self.assertEqual(lines[-1], args[-1])
                if project == 'commerce-ai':
                    self.assertIn('compose.local-shared-networks.yaml', lines)

    def test_ssh_stdin_helpers_send_standalone_canonical_source(self):
        with tempfile.TemporaryDirectory() as directory:
            outside = Path(directory)
            binary = outside / 'bin'
            binary.mkdir()
            ssh = binary / 'ssh'
            ssh.write_text('#!/bin/sh\ncat\n')
            ssh.chmod(0o755)
            env = {**os.environ, 'PATH': str(binary) + os.pathsep + os.environ['PATH']}
            for launcher, source in (
                ('seed-grocery-extra.sh', 'seed-grocery-extra-products.py'),
                ('activate-grocery-visitor-offer.sh', 'grocery-visitor-offer.py'),
            ):
                result = self.run_command(['bash', str(ROOT / 'commerce-ops/deploy/aws-deploy' / launcher)], outside, env=env)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, (ROOT / 'commerce-ops/scripts/demo' / source).read_text())
                parsed = self.run_command([sys.executable, '-B', '-', '--help'], outside, input=result.stdout)
                self.assertEqual(parsed.returncode, 0, parsed.stderr)
                self.assertIn('usage:', parsed.stdout)

    def test_container_stdin_check_does_not_require_a_checkout(self):
        # Replace asyncio.run so loading exercises imports without opening a store.
        source = (ROOT / 'commerce-ops/scripts/checks/assistant-store-check.py').read_text()
        modules = {}
        for name in ('app', 'app.commerce_action_engine', 'app.commerce_action_engine.platform',
                     'app.commerce_action_engine.platform.store', 'psycopg'):
            import types
            modules[name] = types.ModuleType(name)
        modules['app.commerce_action_engine.platform.store'].Store = object
        modules['psycopg'].errors = object()
        with patch.dict(sys.modules, modules), patch('asyncio.run', side_effect=lambda coro: coro.close()):
            exec(compile(source, '<stdin>', 'exec'), {'__name__': '__main__'})

    @unittest.skipUnless(shutil.which('node'), 'Node is required for JS entry points')
    def test_javascript_imports_and_trace_cli_preserve_behavior(self):
        with tempfile.TemporaryDirectory() as directory:
            outside = Path(directory)
            owner = ROOT / 'commerce-ops/scripts/checks/check-trace-rollout.mjs'
            code = f'import {{checkTraceRollout}} from {json.dumps(owner.as_uri())};\n'
            code += "if (checkTraceRollout({}).ok) process.exit(3);"
            result = self.run_command(['node', '--input-type=module', '-e', code], outside)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, '')
            invalid = outside / 'invalid.json'
            invalid.write_text('{}')
            result = self.run_command(['node', str(owner), str(invalid)], outside)
            self.assertEqual(result.returncode, 1)
            owner_cjs = str(ROOT / 'commerce-ops/scripts/demo/mobile-demo-layouts.cjs')
            code = f'if(!require({json.dumps(owner_cjs)})) process.exit(3);'
            result = self.run_command(['node', '-e', code], outside)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_release_fingerprint_tracks_canonical_implementation_changes(self):
        path = ROOT / 'commerce-ops/scripts/release/commerce_reliability.py'
        spec = importlib.util.spec_from_file_location('layout_reliability', path)
        module = importlib.util.module_from_spec(spec)
        old_path = sys.path.copy()
        try:
            spec.loader.exec_module(module)
            original = module.source_manifest()
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                for name in original['files']:
                    target = root / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text('fixture')
                with patch.object(module, 'ROOT', root):
                    before = module.source_manifest()
                    (root / 'commerce-ops/scripts/release/system-qa-http.py').write_text('changed verifier')
                    self.assertNotEqual(before['sha256'], module.source_manifest()['sha256'])
        finally:
            sys.path[:] = old_path

    @unittest.skipUnless(shutil.which('node'), 'Node is required for contract synchronization')
    def test_sync_commands_generate_and_detect_drift_in_an_isolated_checkout(self):
        with tempfile.TemporaryDirectory() as directory:
            outside = Path(directory)
            root = outside / 'checkout'
            for name, source, target in (
                ('sync-theme-contract.mjs', 'commerce-api/theme-contract.json',
                 'commerce-web/packages/api-client/src/theme-contract.json'),
                ('sync-interface-messages.mjs', 'commerce-api/interface-messages.json',
                 'commerce-web/apps/storefront/src/interface-messages.json'),
            ):
                owner = next(path for path in MANIFEST['commands'] if path.endswith('/contracts/' + name))
                path = root / owner
                path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / owner, path)
                for relative in (source, target):
                    (root / relative).parent.mkdir(parents=True, exist_ok=True)
                (root / source).write_text('{"fixture":true}\n')
                command = ['node', str(path)]
                generated = self.run_command(command, outside)
                self.assertEqual(generated.returncode, 0, generated.stderr)
                self.assertEqual((root / target).read_bytes(), (root / source).read_bytes())
                self.assertEqual(self.run_command([*command, '--check'], outside).returncode, 0)
                (root / target).write_text('{}\n')
                self.assertNotEqual(self.run_command([*command, '--check'], outside).returncode, 0)
                self.assertEqual((root / target).read_text(), '{}\n')


if __name__ == '__main__':
    unittest.main()
