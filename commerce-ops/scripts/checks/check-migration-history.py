"""Validate unique SQLx versions and optional read-only database history.

History is psql -At output: version|hex SHA-384 checksum|success (t/f).
No database writes, credentials or network access are used by this checker.
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import argparse
import hashlib
from pathlib import Path
import sys


def validate(directory, history=None, require_all=False):
    migrations = {}
    for path in sorted(directory.glob('*.sql')):
        version_text, separator, description = path.stem.partition('_')
        if not separator or not version_text.isdigit() or not description:
            raise ValueError(f'Invalid migration filename: {path.name}')
        version = int(version_text)
        if version in migrations:
            raise ValueError(f'Duplicate migration version {version}: {migrations[version].name} and {path.name}')
        migrations[version] = path
    if not migrations:
        raise ValueError('No SQL migrations found; refusing an empty release inventory')
    applied = set()
    checked = 0
    for line in (history or '').splitlines():
        if not line.strip():
            continue
        fields = line.split('|')
        if len(fields) != 3 or not fields[0].isdigit():
            raise ValueError('Invalid migration history row')
        version, checksum, success = fields
        path = migrations.get(int(version))
        if success != 't':
            raise ValueError(f'Migration {version} is recorded as unsuccessful')
        if path is None:
            raise ValueError(f'Applied migration {version} is missing from the release')
        if hashlib.sha384(path.read_bytes()).hexdigest() != checksum:
            raise ValueError(f'Applied migration {version} differs from {path.name}; restore its original bytes and use a new migration for changes')
        if int(version) in applied:
            raise ValueError(f'Duplicate applied migration {version}')
        applied.add(int(version))
        checked += 1
    if require_all:
        pending = sorted(set(migrations) - applied)
        if pending:
            names = ', '.join(migrations[version].name for version in pending)
            raise ValueError(f'Release migrations have not been applied: {names}')
    return len(migrations), checked


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--migrations', type=Path, default=Path(__file__).resolve().parents[3] / 'commerce-api/rocento-api/migrations')
    parser.add_argument('--history', type=Path)
    parser.add_argument('--require-all', action='store_true', help='Require every release migration to be applied successfully')
    args = parser.parse_args()
    if args.require_all and not args.history:
        parser.error('--require-all requires --history')
    try:
        count, checked = validate(args.migrations, args.history.read_text() if args.history else None, args.require_all)
    except (ValueError, OSError) as error:
        print(f'Migration preflight failed: {error}', file=sys.stderr)
        return 1
    print(f'Migration preflight passed: {count} unique versions; {checked} applied checksums verified.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
