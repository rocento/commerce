"""Create a dated output run with separate evidence, deliverables and work folders."""

import argparse
from datetime import date
import json
from pathlib import Path
import re
import subprocess


ROOT = Path(__file__).resolve().parents[3]
TEMPLATE = ROOT / 'commerce-docs/platform/reference/output-manifest.example.json'


def create_run(root: Path, purpose: str, run_date: date, owner: str = 'Unassigned') -> Path:
    if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', purpose):
        raise ValueError('purpose must use lowercase letters, digits and single hyphens')
    output = root / 'commerce-output'
    if output.is_symlink():
        raise ValueError('commerce-output root must not be a symlink')
    output.mkdir(exist_ok=True)
    run = output / f'{run_date.isoformat()}-{purpose}'
    template = json.loads((root / TEMPLATE.relative_to(ROOT)).read_text())
    run.mkdir()  # Refuse to overwrite an existing run.
    for name in ('evidence', 'deliverables', 'work'):
        (run / name).mkdir()
    template['run_id'] = run.name
    template['owner'] = owner
    template['purpose'] = purpose.replace('-', ' ')
    template['source']['commit'] = subprocess.run(
        ['git', 'rev-parse', 'HEAD'], cwd=root, capture_output=True, text=True, check=False
    ).stdout.strip() or 'unrecorded'
    template['verification']['limits'] = [
        'Record exact candidate identity and replace starter metadata before treating results as evidence.'
    ]
    (run / 'manifest.json').write_text(json.dumps(template, indent=2) + '\n')
    return run


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('purpose', help='lowercase hyphenated run purpose')
    parser.add_argument('--owner', default='Unassigned', help='responsible person or team')
    parser.add_argument('--date', default=date.today().isoformat(), help='run date, YYYY-MM-DD')
    args = parser.parse_args()
    try:
        run_date = date.fromisoformat(args.date)
        run = create_run(ROOT, args.purpose, run_date, args.owner)
    except (ValueError, FileExistsError) as error:
        parser.error(str(error))
    print(run.relative_to(ROOT))


if __name__ == '__main__':
    main()
