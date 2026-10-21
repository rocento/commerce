"""Operator migration guards and protected credential handling."""

import importlib.util
import runpy
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location(
    "unify_ai", ROOT / "commerce-ops/scripts/maintenance/unify-ai-databases.py"
)
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class MigrationTests(unittest.TestCase):
    def test_history_upgrade_installs_deletion_before_shared_policies(self):
        for shared in (False, True):
            with self.subTest(shared=shared), patch('sys.argv', ['conversations-setup.py', '--container', 'isolated-test']), patch('subprocess.check_output', return_value='t\n' if shared else 'f\n'), patch('subprocess.run') as execute:
                runpy.run_path(str(ROOT / 'commerce-ops/scripts/local/conversations-setup.py'), run_name='__main__')
                sql = execute.call_args.kwargs['input']
                self.assertIn('CREATE TABLE IF NOT EXISTS assistant.deleted_customers', sql)
                self.assertIn('--single-transaction', execute.call_args.args[0])
                if shared:
                    self.assertLess(sql.index('CREATE TABLE IF NOT EXISTS assistant.deleted_customers'), sql.index('CREATE OR REPLACE FUNCTION assistant.login_tenant'))

    def test_secret_is_private_and_never_overwritten(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "password"
            self.assertEqual(migration.write_secret(path, "first"), "first")
            self.assertEqual(migration.write_secret(path, "replacement"), "first")
            self.assertEqual(path.read_text(), "first\n")
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_live_consumer_prevents_reset_before_any_sql(self):
        with (
            tempfile.TemporaryDirectory() as folder,
            patch.object(migration, "ROOT", Path(folder)),
            patch.object(migration, "sql") as sql,
        ):
            path = Path(folder) / "deploy/ec2/grocery-shared-ai.env"
            path.parent.mkdir(parents=True)
            path.touch()
            with self.assertRaisesRegex(RuntimeError, "enabled consumers"):
                migration.reset_candidates()
            sql.assert_not_called()

    def test_sql_literals_escape_quotes(self):
        self.assertEqual(migration.literal("a'b"), "'a''b'")

    def test_data_restore_selects_only_tenant_tables(self):
        with (
            tempfile.TemporaryDirectory() as folder,
            patch.object(migration, "run") as run,
            patch.object(migration, "target_psql") as apply,
        ):
            path = Path(folder) / "backup.dump"
            path.write_bytes(b"test")
            run.return_value.stdout = b"COPY data"
            migration.restore(path, "assistant", data=True)
            args = run.call_args.args[0]
            self.assertIn("--disable-triggers", args)
            self.assertIn("--file=-", args)
            selected = [args[i + 1] for i, a in enumerate(args) if a == "--table"]
            self.assertEqual(tuple(selected), migration.TABLES)
            self.assertNotIn("deployment", selected)
            apply.assert_called_once_with("assistant", b"COPY data", None)


if __name__ == "__main__":
    unittest.main()
