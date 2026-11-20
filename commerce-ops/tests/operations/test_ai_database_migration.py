"""Operator migration guards and protected credential handling."""

import importlib.util
import runpy
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
class MigrationTests(unittest.TestCase):
    def test_history_upgrade_installs_deletion_before_shared_policies(self):
        for shared in (False, True):
            with self.subTest(shared=shared), patch('sys.argv', ['conversations-setup.py', '--container', 'isolated-test']), patch('subprocess.check_output', return_value='t\n' if shared else 'f\n'), patch('subprocess.run') as execute:
                runpy.run_path(str(ROOT / 'commerce-ops/services/assistant/conversations-setup.py'), run_name='__main__')
                sql = execute.call_args.kwargs['input']
                self.assertIn('CREATE TABLE IF NOT EXISTS assistant.deleted_customers', sql)
                self.assertIn('--single-transaction', execute.call_args.args[0])
                if shared:
                    self.assertLess(sql.index('CREATE TABLE IF NOT EXISTS assistant.deleted_customers'), sql.index('CREATE OR REPLACE FUNCTION assistant.login_tenant'))


if __name__ == '__main__':
    unittest.main()
