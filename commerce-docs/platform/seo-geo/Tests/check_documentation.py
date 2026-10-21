"""Check current publication guides and retained compressed archive identities."""
from pathlib import Path
import hashlib
import json
import runpy
import zipfile

root = Path(__file__).resolve().parents[4]
for relative in ('commerce-ai-docs/frontend/publication.md', 'commerce-ai-docs/backend/publication.md'):
    assert (root / relative).is_file(), relative

# Loose deprecated Markdown was removed; the retained archive is evidence only.
archive = root / 'commerce-ai-docs/platform/seo-geo/Archive'
index_path = archive / 'original-files.json'
archive_count = 0
if index_path.is_file():
    index = json.loads(index_path.read_text())
    with zipfile.ZipFile(archive / index['archive']) as bundle:
        assert set(bundle.namelist()) == set(index['sha256'])
        for name, digest in index['sha256'].items():
            assert hashlib.sha256(bundle.read(name)).hexdigest() == digest, name
        archive_count = len(index['sha256'])

runpy.run_path(str(root / 'scripts/check-documentation.py'), run_name='__main__')
print(f'Verified 2 current publication guides and {archive_count} compressed archive entries.')
