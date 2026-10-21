"""Check dated output runs are structured and existing runs are preserved."""

from datetime import date
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SOURCE = Path(__file__).resolve().parents[1] / 'maintenance/new-output-run.py'
spec = importlib.util.spec_from_file_location('new_output_run', SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class NewOutputRunTests(unittest.TestCase):
    def test_creates_dated_run_without_overwriting_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            template = root / module.TEMPLATE.relative_to(module.ROOT)
            template.parent.mkdir(parents=True)
            template.write_bytes(module.TEMPLATE.read_bytes())
            run = module.create_run(root, 'docs-validation', date(2026, 10, 14), 'Docs')
            self.assertEqual(run.name, '2026-10-14-docs-validation')
            self.assertEqual({p.name for p in run.iterdir()},
                             {'manifest.json', 'evidence', 'deliverables', 'work'})
            manifest = json.loads((run / 'manifest.json').read_text())
            self.assertEqual(manifest['run_id'], run.name)
            self.assertEqual(manifest['owner'], 'Docs')
            with self.assertRaises(FileExistsError):
                module.create_run(root, 'docs-validation', date(2026, 10, 14))

    def test_rejects_path_like_purpose(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(ValueError):
                module.create_run(root, '../outside', date(2026, 10, 14))
            self.assertFalse((root / 'output').exists())


if __name__ == '__main__':
    unittest.main()
