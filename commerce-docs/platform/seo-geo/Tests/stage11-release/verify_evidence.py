#!/usr/bin/env python3
"""Check the explicit synthetic release budgets against saved observations."""
import json
from pathlib import Path
from statistics import median

root = Path(__file__).resolve().parents[2] / 'Reports/evidence/stage11-release'
browser = json.loads((root / 'throttled-browser.json').read_text())
rows = browser['rows']
assert len(rows) == 18, 'Expected all 18 image-bearing browser samples'
summary = []
for width in (1440, 390):
    for path in ('/', '/products/apples', '/categories/fruit'):
        group = [r['metrics'] for r in rows if r['viewport']['width'] == width and r['path'] == path]
        assert len(group) == 3
        lcp = median(r['lcp'] for r in group)
        cls = max(r['cls'] for r in group)
        assert 0 < lcp <= 2500, f'{width} {path}: median LCP {lcp} ms exceeds local 2500 ms budget'
        assert cls <= .1, f'{width} {path}: CLS {cls} exceeds local 0.1 budget'
        assert all(any(i['loaded'] for i in r['images']) for r in group)
        summary.append({'width': width, 'path': path, 'median_lcp_ms': lcp, 'max_cls': cls})
workload = json.loads((root / 'release-workload.json').read_text())
assert workload['sustained']['errors'] == 0
assert workload['sustained']['seconds'] >= 60
assert workload['sustained']['p95_ms'] < 1000
feed = workload['full_feed']
assert feed['items'] == 2001 and feed['resources'] == 2204
assert feed['pacing'] == 'actual one-second scheduler pacing'
proxy = json.loads((root / 'proxy-rehearsal.json').read_text())
assert proxy['verified_tls'] and proxy['unknown_host'] == 421
assert proxy['upstream_failure'] == 503 and not proxy['stale_html']
result = {'gate': 'Passed', 'scope': 'synthetic local Linux engineering budgets; not a production release approval', 'browser': summary}
(root / 'engineering-gate.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
