"""Build the standalone React Native APK; verify signing before an optional install."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP.parent / 'tools'))
from check_android_signing import Tools, checked_install, require, verify

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--serial', required=True)
parser.add_argument('--sdk', default=os.environ.get('ANDROID_HOME'))
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--architectures', default='arm64-v8a')
parser.add_argument('--install', action='store_true')
parser.add_argument('--studio-origin')
args = parser.parse_args()
require(args.output.is_absolute() and not args.output.exists(), 'Use a new absolute output directory')
tools = Tools(args.sdk)
args.output.mkdir(parents=True)
with (args.output / 'build.log').open('w') as log:
    result = subprocess.run([str(APP / 'android/gradlew'), '-p', str(APP / 'android'),
        ':app:assembleDebug', '-PreactNativeArchitectures=' + args.architectures,
        *(['-PappBuilder=true', '-PpreviewOrigin=' + args.studio_origin] if args.studio_origin else [])],
        env={**os.environ, 'ANDROID_HOME': str(tools.sdk)}, stdout=log, stderr=subprocess.STDOUT)
require(result.returncode == 0, f'Build failed: {args.output / "build.log"}')
apk = args.output / 'rocento-react-native.apk'
shutil.copyfile(APP / 'android/app/build/outputs/apk/debug/app-debug.apk', apk)
package = 'com.rocento.preview.reactnative'
result = (checked_install(apk, tools, package, args.serial) if args.install
          else verify(apk, tools, package, serial=args.serial))
(args.output / 'signing-check.json').write_text(json.dumps(result, indent=2) + '\n')
print(f'Verified APK: {apk}')
