"""Operator smoke test on EC2; credentials stay in memory and are never printed.

Uses existing demo administrator credentials in the protected bootstrap file.
Checks rengine login, readiness, language resolution, a small benchmark, trace
listing and a live guest assistant turn for each demo. No shopper identity or
commercial mutation payload is sent. Normal provider usage can apply.
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import argparse
import json
import time
from pathlib import Path
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--bootstrap', type=Path, default=Path('/opt/rocento/deploy/ec2/bootstrap.env'))
    parser.add_argument('--journey', action='store_true', help='Require function source and matching rule evidence from a new assistant turn')
    args = parser.parse_args()
    values = {}
    for line in args.bootstrap.read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip().strip('"\'')
    cookie = ''

    def call(path, data=None):
        nonlocal cookie
        headers = {'X-Rengine-Request': '1', 'Origin': 'https://rengine.rocento.com', 'Cookie': cookie}
        if data is not None:
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request('http://127.0.0.1:3190' + path, headers=headers, data=None if data is None else json.dumps(data).encode())
        try:
            with urllib.request.urlopen(request, timeout=100) as response:
                if response.headers.get('Set-Cookie'):
                    cookie = response.headers['Set-Cookie'].split(';', 1)[0]
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f'{path.split("?")[0]} returned HTTP {error.code}') from None

    results = []
    try:
        for store in ('grocery', 'jewelry', 'electronics', 'pharmacy'):
            prefix = store.upper()
            email = values.get(prefix + '_ADMIN_EMAIL')
            password = values.get(prefix + '_ADMIN_PASSWORD')
            if not email or not password:
                raise RuntimeError(f'Missing configured administrator credentials for {store}')
            call('/api/login', {'store': store, 'email': email, 'password': password})
            status = call('/api/status?store=' + store)
            if not status['language']['ready'] or not status['assistant']['ready']:
                raise RuntimeError(f'{store} upstream readiness failed')
            result = call('/api/resolve', {'store': store, 'text': 'show my cart'})
            if result['envelope']['result']['intent'] != 'VIEW_CART':
                raise RuntimeError(f'{store} did not resolve VIEW_CART')
            benchmark = call('/api/benchmark', {'store': store, 'cases': [{'text': 'show my cart', 'expectedIntent': 'VIEW_CART'}], 'iterations': 1})
            if benchmark['summary']['passed'] != 1:
                raise RuntimeError(f'{store} benchmark expectation failed')
            traces = call('/api/traces?store=' + store)
            assistant = call('/api/assistant', {'store': store, 'text': 'show my cart' if args.journey else 'What can you help me with?'})
            if not assistant['events']:
                raise RuntimeError(f'{store} assistant returned no stream events')
            journey_check = {}
            if args.journey:
                for attempt in range(5):
                    try:
                        journey = call('/api/journey?store=' + store + '&id=' + assistant['requestId'])
                        break
                    except RuntimeError:
                        if attempt == 4:
                            raise
                        time.sleep(1)
                functions = [step for step in journey['steps'] if step['kind'] == 'python']
                rules = [step for step in journey['steps'] if step['kind'] == 'rules']
                assert journey['instrumented'] and functions and journey['sources'], store + ': missing function capture'
                assert rules and all(step['rules']['definitionStatus'] == 'matched-generation' for step in rules), store + ': missing matched rules'
                assert any(candidate['definition'] for step in rules for candidate in step['rules']['candidates']), store + ': missing rule definition'
                assert any('def resolve(' in source['source'] for source in journey['sources'].values()), store + ': missing actual resolver source'
                assert any(step['stage'] == 'final_result' for step in journey['steps']), store + ': missing final response'
                journey_check = {'journey_steps': len(journey['steps']), 'captured_functions': len(journey['sources']), 'rule_definitions_verified': True}
            results.append({**journey_check, 'store': store, 'language_ready': True, 'assistant_ready': True,
                            'intent': result['envelope']['result']['intent'],
                            'engine_ms': result['engineMs'], 'round_trip_ms': round(result['elapsedMs'], 2),
                            'benchmark_passed': True, 'trace_listing_accessible': isinstance(traces.get('items'), list),
                            'guest_stream_completed': assistant['completed'],
                            'guest_event_count': len(assistant['events']),
                            'guest_elapsed_ms': round(assistant['elapsedMs'], 2)})
    finally:
        if cookie:
            call('/api/logout', {})
    print(json.dumps({'checks': results}, indent=2))
    if any(not row['guest_stream_completed'] for row in results):
        raise SystemExit('At least one guest stream did not complete; inspect its trace.')


if __name__ == '__main__':
    main()
