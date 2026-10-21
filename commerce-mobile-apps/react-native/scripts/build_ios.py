"""Build this app for a simulator and enforce the existing credential identity gate."""
import argparse
import json
from pathlib import Path
import plistlib
import subprocess
import sys

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP.parent / 'tools'))
from check_ios_signing import baseline_for, check_app, require

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--simulator', required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--install', action='store_true')
parser.add_argument('--studio-origin')
parser.add_argument('--reuse-output', action='store_true', help='Incrementally rebuild a previous output directory')
args = parser.parse_args()
bundle = 'com.rocento.preview.reactnative'
require(args.output.is_absolute() and (not args.output.exists() or (args.reuse_output and (args.output / 'Simulator.entitlements').is_file())), 'Use a new absolute output directory or explicitly reuse a previous build')
baseline = baseline_for(args.simulator, bundle, None)
app_id = 'local.rocento.' + bundle
entitlements = ({key: value for key, value in baseline['entitlements'].items()
                 if key in ('application-identifier', 'keychain-access-groups', 'com.apple.security.application-groups')}
                if baseline else {'application-identifier': app_id, 'keychain-access-groups': [app_id]})
entitlements['get-task-allow'] = True
args.output.mkdir(parents=True, exist_ok=args.reuse_output)
entitlement_file = args.output / 'Simulator.entitlements'
entitlement_file.write_bytes(plistlib.dumps(entitlements))
studio_args = []
if args.studio_origin:
    require(args.studio_origin.startswith('https://'), 'Studio requires HTTPS')
    studio_info = plistlib.loads((APP / 'ios/RocentoPreviewRN/Info.plist').read_bytes())
    studio_info.update(RocentoTenant='312f9ac8-4888-4d35-92a0-e5fdb3bf59b8', RocentoProduction='YES', RocentoBuilderOrigin=args.studio_origin)
    studio_plist = args.output / 'Studio-Info.plist'
    studio_plist.write_bytes(plistlib.dumps(studio_info))
    studio_args = ['INFOPLIST_FILE=' + str(studio_plist), 'SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG ROCENTO_STUDIO',
        'ENTRY_FILE=' + str(APP / 'index.studio.ts'), 'FORCE_BUNDLING=1', 'SKIP_BUNDLING=', 'EXTRA_PACKAGER_ARGS=--dev false',
        'INFOPLIST_KEY_RocentoTenant=312f9ac8-4888-4d35-92a0-e5fdb3bf59b8',
        'INFOPLIST_KEY_RocentoProduction=YES', 'INFOPLIST_KEY_RocentoBuilderOrigin=' + args.studio_origin]
with (args.output / 'build.log').open('w') as log:
    result = subprocess.run(['xcodebuild', '-workspace', str(APP / 'ios/RocentoPreviewRN.xcworkspace'),
        '-scheme', 'RocentoPreviewRN', '-configuration', 'Debug',
        '-destination', f'platform=iOS Simulator,id={args.simulator}',
        '-derivedDataPath', str(args.output / 'DerivedData'), 'CODE_SIGNING_ALLOWED=YES',
        'CODE_SIGN_IDENTITY=-', f'CODE_SIGN_ENTITLEMENTS={entitlement_file}', *studio_args, 'build'],
        stdout=log, stderr=subprocess.STDOUT)
require(result.returncode == 0, f'Build failed: {args.output / "build.log"}')
app = args.output / 'DerivedData/Build/Products/Debug-iphonesimulator/RocentoPreviewRN.app'
checked = check_app(app, 'simulator', bundle, baseline=baseline, expected=entitlements)
current = baseline_for(args.simulator, bundle, None)
if current:
    check_app(app, 'simulator', bundle, baseline=current)
checked['baseline_checked'] = baseline is not None or current is not None
checked['app'] = str(app)
(args.output / 'signing-check.json').write_text(json.dumps(checked, indent=2) + '\n')
if args.install:
    subprocess.run(['xcrun', 'simctl', 'install', args.simulator, str(app)], check=True)
print(f'Verified signed app: {app}')
