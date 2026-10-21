"""Bind the editable Grocery shopping guides to one authorized pilot installation."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID

ROOT = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--tenant', type=UUID, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
collection = json.loads((ROOT / 'commerce-ops/deploy/assistant/pilots/grocery-guides.template.json').read_text())
now = datetime.now(timezone.utc)
collection['tenant_id'] = str(args.tenant)
for answer in collection['answers']:
    answer['source']['approved_at'] = now.isoformat()
    answer['source']['valid_until'] = (now + timedelta(days=30)).isoformat()
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(collection, ensure_ascii=False, indent=2) + '\n')
print('Pilot guides bound to one tenant with a 30-day review window.')
