"""Build a signed simulator app; verify Keychain compatibility before optional installation."""
import argparse
import json
from pathlib import Path
import plistlib
import subprocess
import sys
from urllib.parse import urlparse

from check_ios_signing import BUNDLE_IDS, SigningError, baseline_for, check_app, require

ROOT = Path(__file__).resolve().parents[2]


def build(args):
    bundle_id = BUNDLE_IDS[args.scheme]
    # Studio is a compatibility scheme alias; its product is the canonical app.
    product = args.scheme.removesuffix('Studio')
    builder_settings = []
    if getattr(args, 'builder_origin', None):
        origin = urlparse(args.builder_origin)
        require(product in ('Rocento', 'Electronics', 'Jewelry', 'Pharmacy') and origin.scheme == 'https' and origin.hostname
                and not origin.username and not origin.password and not origin.query and not origin.fragment
                and origin.path in ('', '/', '/api', '/api/'), 'Builder origin requires a merchant scheme and a trusted HTTPS origin')
        builder_settings = ['ROCENTO_BUILDER_ORIGIN=' + args.builder_origin]
    require(args.output.is_absolute() and not args.output.exists(), 'Use a new absolute output directory')
    baseline = baseline_for(args.simulator, bundle_id, args.baseline_app)
    if baseline:
        entitlements = {key: value for key, value in baseline['entitlements'].items()
                        if key in ('application-identifier', 'keychain-access-groups',
                                   'com.apple.security.application-groups')}
    else:
        app_id = 'local.rocento.' + bundle_id
        entitlements = {'application-identifier': app_id, 'keychain-access-groups': [app_id]}
    entitlements['get-task-allow'] = True
    args.output.mkdir(parents=True)
    entitlement_path = args.output / 'Simulator.entitlements'
    entitlement_path.write_bytes(plistlib.dumps(entitlements))
    action = 'build-for-testing' if args.build_for_testing else 'build'
    with (args.output / 'build.log').open('w') as log:
        result = subprocess.run([
            'xcodebuild', '-project', str(ROOT / 'commerce-mobile-apps/ios/RocentoMobile.xcodeproj'),
            '-scheme', args.scheme, '-configuration', 'Debug',
            '-destination', f'platform=iOS Simulator,id={args.simulator}',
            '-derivedDataPath', str(args.output / 'DerivedData'),
            'CODE_SIGNING_ALLOWED=YES', 'CODE_SIGN_IDENTITY=-',
            f'CODE_SIGN_ENTITLEMENTS={entitlement_path}', *builder_settings, action], stdout=log, stderr=subprocess.STDOUT)
    require(result.returncode == 0, f'Xcode build failed; see {args.output / "build.log"}')
    app = args.output / 'DerivedData/Build/Products/Debug-iphonesimulator' / (product + '.app')
    # Re-read the destination after the build: another build may have updated it.
    current = baseline_for(args.simulator, bundle_id, args.baseline_app)
    checked = check_app(app, 'simulator', bundle_id, baseline=baseline, expected=entitlements)
    if current:
        check_app(app, 'simulator', bundle_id, baseline=current)
    checked['baseline_checked'] = baseline is not None or current is not None
    checked['app'] = str(app)
    (args.output / 'signing-check.json').write_text(json.dumps(checked, indent=2) + '\n')
    if args.install:
        # Installation is unreachable on any lookup, signature, or identity failure.
        result = subprocess.run(['xcrun', 'simctl', 'install', args.simulator, str(app)])
        require(result.returncode == 0, 'Simulator installation failed')
    print(f'Verified signed app: {app}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scheme', choices=sorted(BUNDLE_IDS), required=True)
    parser.add_argument('--simulator', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--baseline-app', type=Path, help='Explicit known-good signed app for recovery')
    parser.add_argument('--build-for-testing', action='store_true')
    parser.add_argument('--builder-origin', help='Trusted build-time HTTPS builder origin for local or cloud preview workers')
    parser.add_argument('--install', action='store_true', help='Install only after all checks pass')
    build(parser.parse_args())


if __name__ == '__main__':
    try:
        main()
    except (SigningError, OSError) as error:
        print(f'iOS simulator build stopped: {error}', file=sys.stderr)
        sys.exit(1)
