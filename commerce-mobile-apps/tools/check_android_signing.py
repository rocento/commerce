"""Verify APK signatures and preserve the installed app's credential identity."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

PACKAGES = {'rocento': 'com.rocento.grocery', 'electronics': 'com.rocento.electronics',
            'jewelry': 'com.rocento.jewelry', 'pharmacy': 'com.rocento.pharmacy',
            'market': 'com.rocento.mobile.preview.market', 'boutique': 'com.rocento.mobile.preview.boutique'}
ROOT = Path(__file__).resolve().parents[2]


class SigningError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise SigningError(message)


def command(args):
    result = subprocess.run([str(x) for x in args], capture_output=True, text=True)
    require(result.returncode == 0, f'{Path(args[0]).name} {args[1]} failed; '
            'cannot verify Android signing/device state. Check the artifact, SDK and device connection.')
    return result.stdout


class Tools:
    def __init__(self, sdk=None):
        sdk = sdk or os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT')
        if not sdk:
            local = ROOT / 'commerce-mobile-apps/android/local.properties'
            lines = local.read_text().splitlines() if local.is_file() else []
            sdk = next((x.removeprefix('sdk.dir=') for x in lines if x.startswith('sdk.dir=')), None)
        require(sdk, 'Set ANDROID_HOME or pass --sdk')
        self.sdk = Path(sdk)
        self.aapt = self.sdk / 'build-tools/36.0.0/aapt'
        self.apksigner = self.sdk / 'build-tools/36.0.0/apksigner'
        self.adb = self.sdk / 'platform-tools/adb'
        require(self.aapt.is_file() and self.apksigner.is_file(), 'Install Android SDK Build Tools 36.0.0')

    def device(self, serial, *args):
        require(serial and not serial.startswith('-'), 'An explicit valid Android serial is required')
        return command([self.adb, '-s', serial, *args]).strip()


def fingerprint(value):
    value = value.replace(':', '').lower()
    require(re.fullmatch('[0-9a-f]{64}', value), 'Expected a full SHA-256 signing certificate fingerprint')
    return value


def manifest(tree):
    """Read only direct attributes of manifest/application/instrumentation from aapt."""
    sections = {'manifest': {}, 'application': {}, 'instrumentation': {}}
    current = None
    seen = set()
    for line in tree.splitlines():
        element = re.fullmatch(r'(\s*)E: ([\w-]+) .*', line)
        if element:
            indent, name = len(element[1]), element[2]
            current = name if (name == 'manifest' and indent == 2 or
                              name in ('application', 'instrumentation') and indent == 4) else None
            if current:
                require(current not in seen, 'Duplicate manifest element')
                seen.add(current)
            continue
        attr = re.fullmatch(r'(\s*)A: ([\w:]+)(?:\(0x[0-9a-f]+\))?=(.*)', line)
        if not attr or not current:
            continue
        require(len(attr[1]) == (4 if current == 'manifest' else 6), 'Malformed manifest attributes')
        key, value = attr[2], attr[3]
        require(key not in sections[current], 'Duplicate manifest attribute')
        string = re.fullmatch(r'"([^"\n]*)"(?: \(Raw: "[^"\n]*"\))?', value)
        integer = re.fullmatch(r'\(type 0x1[012]\)0x([0-9a-f]+)', value)
        sections[current][key] = string[1] if string else int(integer[1], 16) if integer else value
    root = sections['manifest']
    require('manifest' in seen and 'application' in seen, 'Cannot read APK manifest')
    require(not any(x in root for x in ('android:sharedUserId', 'android:sharedUserMaxSdkVersion')),
            'Shared UID manifests are unsupported; preserve the app-private Keystore namespace')
    require('split' not in root and not root.get('android:isFeatureSplit'), 'Split APKs require a separate verified delivery flow')
    package = root.get('package')
    require(isinstance(package, str) and re.fullmatch(r'[A-Za-z]\w*(?:\.[A-Za-z]\w*)+', package), 'Invalid APK package ID')
    target = sections['instrumentation'].get('android:targetPackage')
    # AGP's test APKs omit versionCode; Android treats that as zero. Merchant
    # APKs still require an explicit version so accidental downgrades fail.
    version = root.get('android:versionCode', 0 if isinstance(target, str) and target else None)
    major = root.get('android:versionCodeMajor', 0)
    require(type(version) is int and type(major) is int and 0 <= version < 2**32 and 0 <= major < 2**32,
            'Invalid APK version code')
    return {'package_id': package, 'version_code': major * 2**32 + version,
            'debuggable': bool(sections['application'].get('android:debuggable', 0)),
            'instrumentation_target': target}


def inspect_apk(apk, tools, package_id):
    require(Path(apk).is_file(), f'APK not found: {apk}')
    verified = command([tools.apksigner, 'verify', '--verbose', '--print-certs', apk])
    count = re.findall(r'^Number of signers: (\d+)$', verified, re.M)
    certs = re.findall(r'^Signer #(\d+) certificate SHA-256 digest: ([0-9a-fA-F]{64})$', verified, re.M)
    require(count == ['1'] and len(certs) == 1 and certs[0][0] == '1',
            'Expected one verified APK signer; multiple signers/unknown signature output need a reviewed migration')
    info = manifest(command([tools.aapt, 'dump', 'xmltree', apk, 'AndroidManifest.xml']))
    require(info['package_id'] == package_id, 'APK package changed or wrong merchant artifact')
    return {**info, 'certificate_sha256': fingerprint(certs[0][1]),
            'apk_sha256': hashlib.sha256(Path(apk).read_bytes()).hexdigest()}


def compatible(candidate, baseline):
    require(candidate['package_id'] == baseline['package_id'], 'Android package identity changed')
    require(candidate['certificate_sha256'] == baseline['certificate_sha256'],
            'Android signing certificate changed; do not uninstall or clear data. '
            'Use the established app-signing key. Key rotation requires a separately tested migration.')
    require(candidate['version_code'] >= baseline['version_code'], 'APK version downgrade is not allowed')
    require(candidate['instrumentation_target'] == baseline['instrumentation_target'], 'Instrumentation target changed')


def installed_identity(tools, serial, package_id):
    require(tools.device(serial, 'get-state') == 'device', 'Android device is not ready')
    user = tools.device(serial, 'shell', 'am', 'get-current-user')
    require(re.fullmatch(r'\d+', user), 'Cannot determine the Android user')
    # Include retained/uninstalled packages and other users. Never mistake missing
    # APK bytes or an ADB failure for a clean installation with no saved data.
    inventory = tools.device(serial, 'shell', 'pm', 'list', 'packages', '-u').splitlines()
    require(inventory and all(re.fullmatch(r'package:[\w.]+', x) for x in inventory)
            and 'package:android' in inventory, 'Cannot verify the Android package inventory')
    if 'package:' + package_id not in inventory:
        return None, user
    paths = tools.device(serial, 'shell', 'pm', 'path', '--user', user, package_id).splitlines()
    require(len(paths) == 1 and paths[0].startswith('package:/') and paths[0].endswith('.apk'),
            'Installed/retained package has no single readable APK; stop for explicit recovery or split-APK validation')
    with tempfile.TemporaryDirectory(prefix='android-signing-baseline-') as directory:
        apk = Path(directory) / 'installed.apk'
        tools.device(serial, 'pull', paths[0].removeprefix('package:'), str(apk))
        return inspect_apk(apk, tools, package_id), user


def connected_devices(tools):
    lines = command([tools.adb, 'devices']).strip().splitlines()
    require(lines and lines[0] == 'List of devices attached', 'Cannot read Android devices')
    devices = [line.split() for line in lines[1:] if line.strip()]
    require(devices and all(len(x) == 2 and x[1] == 'device' for x in devices),
            'All connected Android devices must be online and authorized')
    return [x[0] for x in devices]


def verify(apk, tools, package_id, *, serial=None, baseline_apk=None, expected_cert=None, release=False):
    candidate = inspect_apk(apk, tools, package_id)
    require(not release or not candidate['debuggable'], 'Release delivery cannot use a debuggable APK')
    if expected_cert:
        require(candidate['certificate_sha256'] == fingerprint(expected_cert), 'Signing certificate does not match the owner pin')
    baseline, user = None, None
    if baseline_apk:
        baseline = inspect_apk(baseline_apk, tools, package_id)
        compatible(candidate, baseline)
    if serial:
        installed, user = installed_identity(tools, serial, package_id)
        if installed:
            compatible(candidate, installed)
            baseline = installed
    return {**candidate, 'baseline_checked': baseline is not None, 'serial': serial, 'android_user': user}


def checked_install(apk, tools, package_id, serial, *, expected_cert=None, release=False):
    # Use a private snapshot so a concurrent Gradle build cannot replace the
    # verified bytes between inspection and installation. No uninstall/-d fallback.
    with tempfile.TemporaryDirectory(prefix='android-checked-install-') as directory:
        snapshot = Path(directory) / 'verified.apk'
        shutil.copyfile(apk, snapshot)
        result = verify(snapshot, tools, package_id, serial=serial, expected_cert=expected_cert, release=release)
        output = tools.device(serial, 'install', '-r', '--user', result['android_user'], str(snapshot))
        require('Success' in output.splitlines(), 'Android installation did not report success; data was not reset')
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('apk', type=Path)
    identity = parser.add_mutually_exclusive_group(required=True)
    identity.add_argument('--package-id')
    identity.add_argument('--flavor', choices=sorted(PACKAGES))
    parser.add_argument('--sdk')
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--serial')
    source.add_argument('--connected-devices', action='store_true')
    source.add_argument('--baseline-apk', type=Path)
    source.add_argument('--new-installation', action='store_true')
    parser.add_argument('--expected-cert-sha256')
    parser.add_argument('--release', action='store_true')
    parser.add_argument('--test-apk', type=Path, help='Also verify the instrumented test APK before Gradle installs it')
    parser.add_argument('--install', action='store_true', help='Install a private verified snapshot on --serial using -r')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    package_id = args.package_id or PACKAGES[args.flavor]
    require(not args.new_installation or args.expected_cert_sha256,
            'Offline new installations require --expected-cert-sha256 from the intended signing certificate')
    require(not args.install or (args.serial and not args.test_apk),
            '--install requires --serial and checks one APK')
    tools = Tools(args.sdk)
    if args.install:
        reports = [checked_install(args.apk, tools, package_id, args.serial,
                                   expected_cert=args.expected_cert_sha256, release=args.release)]
    else:
        serials = connected_devices(tools) if args.connected_devices else [args.serial]
        reports = []
        for serial in serials:
            result = verify(args.apk, tools, package_id, serial=serial, baseline_apk=args.baseline_apk,
                            expected_cert=args.expected_cert_sha256, release=args.release)
            if args.test_apk:
                test = verify(args.test_apk, tools, package_id + '.test', serial=serial)
                require(test['instrumentation_target'] == package_id, 'Test APK targets the wrong application')
                require(test['certificate_sha256'] == result['certificate_sha256'], 'Test APK signer differs from app signer')
                result['test_apk'] = test
            reports.append(result)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(reports, indent=2) + '\n')
    print('Android signature and saved-credential identity checks passed' + ('; update installed' if args.install else ''))


if __name__ == '__main__':
    try:
        main()
    except (SigningError, OSError) as error:
        print(f'Android signing check failed: {error}', file=sys.stderr)
        sys.exit(1)
