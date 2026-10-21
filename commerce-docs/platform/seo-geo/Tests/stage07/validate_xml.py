"""Validate captured real HTTP sitemap documents using the official bundled XSDs."""
import json
import pathlib
import subprocess
import tempfile

root = pathlib.Path(__file__).resolve().parent
samples = root.parents[1] / 'Reports/evidence/stage07/sitemap-samples.json'
with tempfile.TemporaryDirectory() as directory:
    for i, document in enumerate(json.loads(samples.read_text())):
        path = pathlib.Path(directory) / f'{i}.xml'
        path.write_text(document)
        schema = root / ('siteindex.xsd' if '<sitemapindex ' in document else 'sitemap.xsd')
        subprocess.run(['xmllint', '--nonet', '--noout', '--schema', str(schema), str(path)], check=True)
print('All captured sitemap documents passed official XSD validation.')
