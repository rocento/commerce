import hashlib
import importlib.util
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('migration_check', ROOT / 'commerce-ops/scripts/checks/check-migration-history.py')
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class MigrationPreflightTests(unittest.TestCase):
    def test_rejects_duplicate_version_with_different_names(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory)
            (p / '123_market.sql').write_text('SELECT 1;')
            (p / '123_fulfillment.sql').write_text('SELECT 2;')
            with self.assertRaisesRegex(ValueError, 'Duplicate migration version 123'):
                checker.validate(p)

    def test_history_accepts_pending_migrations_but_rejects_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory)
            (p / '123_original.sql').write_text('SELECT 1;')
            (p / '124_pending.sql').write_text('SELECT 2;')
            digest = hashlib.sha384(b'SELECT 1;').hexdigest()
            self.assertEqual(checker.validate(p, f'123|{digest}|t\n'), (2, 1))
            for history, error in [(f'122|{digest}|t', 'missing'), (f'123|{digest}|f', 'unsuccessful'), ('123|bad|t', 'differs'), ('garbage', 'Invalid')]:
                with self.subTest(history=history), self.assertRaisesRegex(ValueError, error):
                    checker.validate(p, history)

    def test_completion_check_rejects_pending_and_accepts_complete_history(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory)
            (p / '123_original.sql').write_text('SELECT 1;')
            (p / '124_navigation_release_translations.sql').write_text('SELECT 2;')
            first = hashlib.sha384(b'SELECT 1;').hexdigest()
            second = hashlib.sha384(b'SELECT 2;').hexdigest()
            with self.assertRaisesRegex(ValueError, '124_navigation_release_translations.sql'):
                checker.validate(p, f'123|{first}|t\n', require_all=True)
            self.assertEqual(checker.validate(p, f'123|{first}|t\n124|{second}|t\n', require_all=True), (2, 2))
            with self.assertRaisesRegex(ValueError, 'Duplicate applied migration'):
                checker.validate(p, f'123|{first}|t\n123|{first}|t\n', require_all=True)

    def test_migrations_are_verified_before_frontend_publication(self):
        script = (ROOT / 'commerce-ops/deploy/ec2/server/ec2-up.sh').read_text()
        sequence = script.rsplit('\npreflight\n', 1)[1]
        self.assertLess(sequence.index('\ninternal_ready\n'), sequence.index('\nverify_release_migrations\n'))
        self.assertLess(sequence.index('\nverify_release_migrations\n'), sequence.index('\npublish_nginx\n'))
        verification = script.split('verify_release_migrations() {', 1)[1].split('frontend_current()', 1)[0]
        self.assertIn('for store in grocery jewelry electronics', verification)
        self.assertIn('--require-all', verification)
        self.assertIn('ON_ERROR_STOP=1', verification)

    def test_empty_inventory_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, 'No SQL migrations'):
                checker.validate(Path(directory))

    def test_preflight_precedes_all_builds_and_application_replacements(self):
        script = (ROOT / 'commerce-ops/deploy/ec2/server/ec2-up.sh').read_text()
        sequence = script.rsplit('\npreflight\n', 1)[1]
        operations = ['prepare_configuration', 'migration_preflight', 'build_frontend', 'publish_ingress', 'start_store grocery']
        positions = [sequence.index('\n' + operation + '\n') for operation in operations]
        self.assertEqual(positions, sorted(positions))
        self.assertIn('deployment_gate.py" artifacts', sequence)

    @unittest.skipUnless(shutil.which('rsync'), 'rsync required')
    def test_exact_mirror_archives_stale_sql_without_touching_sibling_data(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory)
            source = p / 'source'; source.mkdir()
            destination = p / 'commerce-api/rocento-api/migrations'; destination.mkdir(parents=True)
            backup = p / 'backups'
            secret = p / 'commerce-api/settings.env'; secret.write_text('preserve-test-fixture')
            old = '123_fulfillment.sql'
            (destination / old).write_text('stale SQL')
            (source / '123_market.sql').write_text('current SQL')
            shutil.copytree(destination, backup)
            subprocess.run(['rsync', '-az', '--delete', f'{source}/', f'{destination}/'], check=True, capture_output=True)
            self.assertEqual([f.name for f in destination.iterdir()], ['123_market.sql'])
            self.assertEqual((backup / old).read_text(), 'stale SQL')
            self.assertEqual(secret.read_text(), 'preserve-test-fixture')
            self.assertEqual(checker.validate(destination), (1, 0))


if __name__ == '__main__':
    unittest.main()
