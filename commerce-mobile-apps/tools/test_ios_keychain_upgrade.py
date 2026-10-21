"""Verify signed compatibility-alias → canonical-app Keychain continuity on a disposable simulator.

Uses synthetic fixture data and fails if the seed identity already has records.
Never uninstalls an app, erases Keychain data, or falls back to production HTTP.
"""
import argparse
import json
from pathlib import Path
import plistlib
import subprocess
import sys

TOOLS = Path(__file__).resolve().parent


def run(arguments, log=None):
    if log:
        with log.open('w') as stream:
            subprocess.run(arguments, stdout=stream, stderr=subprocess.STDOUT, check=True)
    else:
        subprocess.run(arguments, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--simulator', required=True)
    parser.add_argument('--standalone', type=Path, required=True, help='Checked build_ios_simulator.py output')
    parser.add_argument('--studio', type=Path, required=True, help='Checked build_ios_simulator.py output')
    parser.add_argument('--output', type=Path, required=True, help='New evidence directory')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    results = []
    for index, (mode, phase) in enumerate([
        ('studio', 'seed'), ('studio', 'restore'), ('standalone', 'restore'),
        ('standalone', 'restore'), ('studio', 'restore'), ('studio', 'finish'),
    ]):
        source = getattr(args, mode).resolve() / 'DerivedData/Build/Products'
        scheme = 'Rocento'
        manifest_scheme = 'RocentoStudio' if mode == 'studio' else 'Rocento'
        app = source / 'Debug-iphonesimulator' / (scheme + '.app')
        prefix = args.output.resolve() / f'{index + 1}-{mode}-{phase}'
        run([sys.executable, str(TOOLS / 'check_ios_signing.py'), str(app),
             '--platform', 'simulator', '--bundle-id', 'com.rocento.grocery',
             '--simulator', args.simulator, '--report', str(prefix) + '-signing.json'])
        candidates = list(source.glob(manifest_scheme + '_*.xctestrun'))
        if len(candidates) != 1:
            raise RuntimeError(f'Expected exactly one test manifest for {scheme}')
        manifest = plistlib.loads(candidates[0].read_bytes())
        target = scheme + 'UITests'
        # Moving the manifest changes __TESTROOT__; resolve its existing entries.
        def resolve(value):
            if isinstance(value, str):
                return value.replace('__TESTROOT__', str(source))
            if isinstance(value, dict):
                return {key: resolve(item) for key, item in value.items()}
            if isinstance(value, list):
                return [resolve(item) for item in value]
            return value
        manifest = resolve(manifest)
        manifest[target].setdefault('EnvironmentVariables', {})['ROCENTO_KEYCHAIN_UPGRADE'] = '1'
        test_manifest = Path(str(prefix) + '.xctestrun')
        test_manifest.write_bytes(plistlib.dumps(manifest))
        run(['xcodebuild', 'test-without-building', '-xctestrun', str(test_manifest),
             '-destination', 'platform=iOS Simulator,id=' + args.simulator,
             '-only-testing:' + target + '/StorefrontUITests/testKeychainUpgrade' + phase.capitalize(),
             '-resultBundlePath', str(prefix) + '.xcresult'], Path(str(prefix) + '.log'))
        summary = json.loads(subprocess.check_output([
            'xcrun', 'xcresulttool', 'get', 'test-results', 'summary',
            '--path', str(prefix) + '.xcresult',
        ], text=True))
        if (summary.get('passedTests'), summary.get('failedTests'), summary.get('skippedTests')) != (1, 0, 0):
            raise RuntimeError('Expected exactly one passing, non-skipped acceptance test')
        results.append({'mode': mode, 'phase': phase, 'result': 'passed'})
        (args.output / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
        print(f'{mode} {phase}: passed', flush=True)


if __name__ == '__main__':
    main()
