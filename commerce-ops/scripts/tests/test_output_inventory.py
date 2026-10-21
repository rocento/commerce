"""Ensure output inventory remains read-only and never follows external symlinks."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('output_inventory', Path(__file__).resolve().parents[1] / 'inventory-outputs.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class OutputInventoryTests(unittest.TestCase):
    def test_counts_nested_workspaces_without_reading_symlink_targets(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as external:
            root = Path(directory)
            run = root / 'commerce-output/run'
            (run / 'snapshot/output/old').mkdir(parents=True)
            (run / 'README.md').write_bytes(b'# Run\n')
            (run / 'manifest.json').write_bytes(b'{}\n')
            report = run / 'snapshot/output/old/report.md'
            report.write_bytes(b'# Evidence\n')
            (Path(external) / 'private.txt').write_text('not part of inventory')
            (run / 'external').symlink_to(external, target_is_directory=True)
            (run / 'broken').symlink_to(root / 'missing')
            record, = module.inventory(root)['runs']
            self.assertEqual(record['files'], 3)
            self.assertEqual(record['logical_bytes'], 20)
            self.assertEqual(record['markdown_files'], 2)
            self.assertEqual(record['symlinks_skipped'], 2)
            self.assertEqual(record['nested_output_directories'], ['commerce-output/run/snapshot/output'])
            self.assertEqual(record['metadata_candidates'], ['README.md', 'manifest.json'])
            self.assertEqual(record['retention_decision'], 'review-required')
            self.assertEqual(report.read_bytes(), b'# Evidence\n')

    def test_absent_output_roots_and_symlink_roots_are_ignored(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as external:
            root = Path(directory)
            (root / 'commerce-output').symlink_to(external, target_is_directory=True)
            self.assertEqual(module.inventory(root)['runs'], [])


if __name__ == '__main__':
    unittest.main()
