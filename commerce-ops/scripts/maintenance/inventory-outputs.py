"""Inventory local output metadata without reading contents, following links or deleting files."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUTPUT_ROOTS = ('commerce-output', 'commerce-artifacts')
NESTED_OUTPUT_NAMES = {'output', 'commerce-output'}


def inventory(root: Path) -> dict:
    runs = []
    for name in OUTPUT_ROOTS:
        directory = root / name
        if not directory.is_dir() or directory.is_symlink():
            continue
        for entry in sorted(directory.iterdir()):
            record = {'path': entry.relative_to(root).as_posix(), 'files': 0,
                      'logical_bytes': 0, 'markdown_files': 0, 'symlinks_skipped': 0,
                      'nested_output_directories': [], 'metadata_candidates': [],
                      'errors': [], 'retention_decision': 'review-required'}
            if entry.is_symlink():
                record['symlinks_skipped'] = 1
                runs.append(record)
                continue

            def inspect(path):
                if path.is_symlink():
                    record['symlinks_skipped'] += 1
                    return
                try:
                    size = path.stat().st_size
                except OSError as error:
                    record['errors'].append(f'{path.relative_to(root)}: {error.strerror}')
                    return
                record['files'] += 1
                record['logical_bytes'] += size
                record['markdown_files'] += int(path.suffix.lower() in {'.md', '.mdx'})
                if path.parent == entry and (path.name == 'README.md' or
                        (path.suffix == '.json' and any(word in path.stem for word in ('manifest', 'verification', 'report')))):
                    record['metadata_candidates'].append(path.name)

            if entry.is_file():
                inspect(entry)
            else:
                def on_error(error):
                    record['errors'].append(f'{error.filename}: {error.strerror}')
                for current, directories, files in os.walk(entry, followlinks=False, onerror=on_error):
                    parent = Path(current)
                    for child in list(directories):
                        path = parent / child
                        if path.is_symlink():
                            record['symlinks_skipped'] += 1
                            directories.remove(child)
                        elif child in NESTED_OUTPUT_NAMES:
                            record['nested_output_directories'].append(path.relative_to(root).as_posix())
                    for filename in files:
                        inspect(parent / filename)
            record['metadata_candidates'].sort()
            record['nested_output_directories'].sort()
            runs.append(record)
    return {'version': 1, 'captured_at': datetime.now(timezone.utc).isoformat(),
            'scope': 'Metadata only; logical file sizes, not allocated disk usage. Active runs may change during scanning. No deletion eligibility is inferred.',
            'runs': runs}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    print(json.dumps(inventory(ROOT), indent=2))


if __name__ == '__main__':
    main()
