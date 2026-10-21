"""Release identity and fail-closed verification without Docker."""
import hashlib
import json
from pathlib import Path
import platform
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import commerce_release as release


class ReleaseTests(unittest.TestCase):
    def bundle(self, root):
        files = {'commerce-api/rocento-api/migrations/1.sql': 'migration-hash'}
        source = {'files': files, 'sha256': hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()}
        (root / 'source-manifest.json').write_text(json.dumps(source))
        for name in release.BINARIES:
            (root / name).write_bytes(b'synthetic executable')
            (root / name).chmod(0o500)
        manifest = {'schema_version': 1, 'host': [platform.system(), platform.machine()],
                    'profile': 'debug', 'git_revision': 'local-reference', 'source_sha256': source['sha256'],
                    'binaries': {n: release.digest(root / n) for n in release.BINARIES}, 'migration_files': files}
        (root / 'release.json').write_text(json.dumps(manifest))
        return manifest

    def test_complete_bundle_loads(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = self.bundle(root)
            self.assertEqual(release.load_bundle(root), expected)

    def test_binary_corruption_missing_worker_and_symlink_fail(self):
        for mutation in ('corrupt', 'missing', 'symlink'):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.bundle(root)
                path = root / 'analytics-worker'
                path.unlink()
                if mutation == 'corrupt':
                    path.write_bytes(b'changed')
                    path.chmod(0o500)
                elif mutation == 'symlink':
                    path.symlink_to(root / 'api-gateway')
                with self.assertRaises(RuntimeError):
                    release.load_bundle(root)

    def test_platform_source_and_migration_mismatch_fail(self):
        for field, value in [('host', ['other', 'cpu']), ('source_sha256', 'changed'), ('migration_files', {})]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                manifest = self.bundle(root)
                manifest[field] = value
                (root / 'release.json').write_text(json.dumps(manifest))
                with self.assertRaises(RuntimeError):
                    release.load_bundle(root)

    def test_verify_requires_full_fault_scenarios_and_propagates_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.bundle(root)
            with patch.object(release.baseline, 'main', return_value=1) as run:
                self.assertEqual(release.main(['verify', '--candidate', str(root)]), 1)
            args = run.call_args.args[0]
            self.assertIn('--analytics-faults', args)
            self.assertIn('--async-faults', args)
            self.assertIn('--candidate-bundle', args)
            self.assertNotIn('--rollback-bundle', args)

    def test_provider_cleanup_runs_even_if_worker_shutdown_fails(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as directory:
            stack = object.__new__(release.baseline.BaselineStack)
            stack.directory = Path(directory)
            stack.path = stack.directory / 'compose.json'
            stack.path.touch()
            stack.stop_engagement = Mock(side_effect=RuntimeError('worker timeout'))
            stack.stop_analytics = Mock()
            stack.stop_api = Mock()
            stack.compose = Mock(return_value=b'')
            with self.assertRaisesRegex(RuntimeError, 'Service cleanup failed'):
                stack.close()
            stack.stop_analytics.assert_called_once()
            stack.stop_api.assert_called_once()
            stack.compose.assert_any_call('down', '--volumes', '--remove-orphans')


if __name__ == '__main__':
    unittest.main()
