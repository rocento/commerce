import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location('delivery_import', Path(__file__).parents[1] / 'import-delivery-locations.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def row(id, feature, state, name='Place', lat='29', lon='48'):
    return '\t'.join([str(id), name, name, 'مكان', lat, lon, 'A' if feature == 'ADM1' else 'P', feature, 'KW', '', state, '', '', '', '20', '', '', 'Asia/Kuwait', '2026-09-01'])


class DeliveryImportTest(unittest.TestCase):
    def rows(self):
        return [value for n in range(1, 7) for value in [row(n, 'ADM1', f'{n:02}', f'Region {n}'), row(100+n, 'PPL', f'{n:02}')]]

    def build(self, root, rows):
        archive = root / 'KW.zip'
        with zipfile.ZipFile(archive, 'w') as source:
            source.writestr('KW.txt', '\n'.join(rows))
        return module.build('KW', archive, root / 'out')

    def test_reproducible_partition_and_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = self.build(root, self.rows() + [row(300, 'PPL', '00'), row(301, 'PPLH', '01')])
            self.assertEqual(manifest['city_count'], 6)
            self.assertEqual(manifest['excluded'], {'unassigned_adm1': 1})
            self.assertEqual(len(manifest['source_sha256']), 64)
            before = {p.name: p.read_bytes() for p in (root/'out').iterdir()}
            module.build('KW', root/'KW.zip', root/'out')
            self.assertEqual(before, {p.name: p.read_bytes() for p in (root/'out').iterdir()})
            for state in manifest['states']:
                records = json.loads((root/'out'/f'{state["code"]}.json').read_text())
                self.assertEqual(len(records), state['city_count'])

    def test_invalid_source_never_publishes_partial_files(self):
        for bad_rows in [self.rows() + [row(101, 'PPL', '02')], self.rows() + [row(999, 'PPL', '02', lat='NaN')], self.rows()[:-2], ['broken']]:
            with self.subTest(rows=bad_rows), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                with self.assertRaises(ValueError):
                    self.build(root, bad_rows)
                self.assertFalse((root/'out').exists())


if __name__ == '__main__':
    unittest.main()
