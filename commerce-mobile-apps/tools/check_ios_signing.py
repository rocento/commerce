"""Fail before installation if an iOS app would lose its Keychain identity."""
import argparse
from datetime import datetime, timezone
import fnmatch
import json
from pathlib import Path
import plistlib
import subprocess
import struct
import sys
import tempfile

MERCHANTS = {'Rocento': 'grocery', 'Electronics': 'electronics',
             'Jewelry': 'jewelry', 'Pharmacy': 'pharmacy'}
BUNDLE_IDS = {scheme + suffix: 'com.rocento.' + merchant
              for scheme, merchant in MERCHANTS.items() for suffix in ('', 'Studio')}
BUNDLE_IDS.update({'Market': 'com.rocento.mobile.preview.market',
                   'Boutique': 'com.rocento.mobile.preview.boutique'})


class SigningError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise SigningError(message)


def command(args, *, data=None):
    result = subprocess.run(args, input=data, capture_output=True)
    require(result.returncode == 0,
            f'{args[0]} {args[1]} failed; cannot verify signing/installed identity. '
            'Check tool availability, simulator state, and the signed artifact.')
    return result.stdout


def plist(data, description):
    try:
        result = plistlib.loads(data)
    except Exception as error:
        raise SigningError(f'Cannot read {description} as a plist') from error
    require(isinstance(result, dict), f'Invalid {description}')
    return result


def string_list(value, name):
    require(isinstance(value, list) and all(isinstance(x, str) and x and '*' not in x
            and '$' not in x for x in value), f'Invalid or unresolved {name}')
    require(len(value) == len(set(value)), f'Duplicate {name}')
    return value


def identity(info, entitlements, platform, bundle_id):
    require(info.get('CFBundleIdentifier') == bundle_id, 'Bundle ID changed or wrong merchant app')
    expected_platform = 'iPhoneSimulator' if platform == 'simulator' else 'iPhoneOS'
    require(info.get('CFBundleSupportedPlatforms') == [expected_platform], 'Wrong app platform')
    app_id = entitlements.get('application-identifier')
    require(isinstance(app_id, str) and app_id.endswith('.' + bundle_id)
            and app_id != '.' + bundle_id and '*' not in app_id and '$' not in app_id,
            'Missing, unresolved, or mismatched application-identifier')
    groups = string_list(entitlements.get('keychain-access-groups', []), 'keychain-access-groups')
    app_groups = string_list(entitlements.get('com.apple.security.application-groups', []), 'app groups')
    if platform == 'simulator':
        require(groups, 'Simulator app has no explicit Keychain access group')
        require(entitlements.get('get-task-allow') is True, 'Simulator debug entitlement is missing')
    else:
        require(not app_id.startswith('local.rocento.'), 'Simulator identity cannot sign a device app')
    # Apple uses explicit keychain groups first, then app ID, then app groups.
    effective = list(dict.fromkeys([*groups, app_id, *app_groups]))
    return {'bundle_id': bundle_id, 'platform': platform, 'application_identifier': app_id,
            'default_group': effective[0], 'access_groups': effective,
            'entitlements': entitlements}


def simulator_entitlements(binary):
    """Read Xcode's __TEXT,__entitlements from every thin/fat Mach-O slice.

    The caller verifies the code signature first, which also protects these bytes.
    Simulator effective entitlements may be absent from the signature's plist.
    """
    fat = {b'\xca\xfe\xba\xbe': ('>', 20), b'\xbe\xba\xfe\xca': ('<', 20),
           b'\xca\xfe\xba\xbf': ('>', 32), b'\xbf\xba\xfe\xca': ('<', 32)}
    thin = {b'\xce\xfa\xed\xfe': ('<', 28), b'\xfe\xed\xfa\xce': ('>', 28),
            b'\xcf\xfa\xed\xfe': ('<', 32), b'\xfe\xed\xfa\xcf': ('>', 32)}

    def number(data, offset, fmt):
        require(offset >= 0 and offset + struct.calcsize(fmt) <= len(data), 'Truncated Mach-O metadata')
        return struct.unpack_from(fmt, data, offset)[0]

    slices = [binary]
    if binary[:4] in fat:
        endian, width = fat[binary[:4]]
        count = number(binary, 4, endian + 'I')
        require(0 < count <= 32 and 8 + count * width <= len(binary), 'Invalid Mach-O architecture table')
        slices, ranges, architectures = [], [], set()
        for index in range(count):
            cursor = 8 + index * width
            architecture = binary[cursor:cursor + 8]
            require(architecture not in architectures, 'Duplicate Mach-O architecture')
            architectures.add(architecture)
            integer = 'I' if width == 20 else 'Q'
            offset = number(binary, cursor + 8, endian + integer)
            size = number(binary, cursor + (12 if width == 20 else 16), endian + integer)
            require(offset >= 8 + count * width and size > 0 and offset + size <= len(binary),
                    'Invalid Mach-O slice range')
            require(all(offset + size <= a or offset >= b for a, b in ranges), 'Overlapping Mach-O slices')
            ranges.append((offset, offset + size))
            slices.append(binary[offset:offset + size])
    results = []
    for data in slices:
        require(data[:4] in thin, 'Simulator executable is not a supported Mach-O')
        endian, header_size = thin[data[:4]]
        count, command_size = number(data, 16, endian + 'I'), number(data, 20, endian + 'I')
        end = header_size + command_size
        require(0 < count <= 65536 and end <= len(data), 'Invalid Mach-O load commands')
        cursor, found = header_size, []
        for _ in range(count):
            require(cursor + 8 <= end, 'Truncated Mach-O load command')
            cmd, size = number(data, cursor, endian + 'I'), number(data, cursor + 4, endian + 'I')
            require(size >= 8 and cursor + size <= end, 'Invalid Mach-O load command size')
            if cmd in (1, 25):  # LC_SEGMENT / LC_SEGMENT_64
                segment_size, section_size = (56, 68) if cmd == 1 else (72, 80)
                require(size >= segment_size, 'Truncated Mach-O segment')
                sections = number(data, cursor + (48 if cmd == 1 else 64), endian + 'I')
                require(segment_size + sections * section_size <= size, 'Invalid Mach-O section table')
                for index in range(sections):
                    section = cursor + segment_size + index * section_size
                    if data[section:section + 16].rstrip(b'\0') != b'__entitlements':
                        continue
                    if data[section + 16:section + 32].rstrip(b'\0') != b'__TEXT':
                        continue
                    length = number(data, section + (36 if cmd == 1 else 40), endian + ('I' if cmd == 1 else 'Q'))
                    offset = number(data, section + (40 if cmd == 1 else 48), endian + 'I')
                    require(length > 0 and offset >= end and offset + length <= len(data),
                            'Invalid embedded entitlement range')
                    found.append(plist(data[offset:offset + length].rstrip(b'\0'), 'embedded simulator entitlements'))
            cursor += size
        require(cursor == end, 'Inconsistent Mach-O load command size')
        require(len(found) == 1, 'Every simulator architecture must contain exactly one __TEXT,__entitlements section')
        results.append(found[0])
    require(all(value == results[0] for value in results), 'Simulator architectures have different entitlements')
    return results[0]


def inspect_app(app, platform, bundle_id):
    app = Path(app)
    require(app.is_dir() and (app / 'Info.plist').is_file(), f'App bundle not found: {app}')
    info = plist((app / 'Info.plist').read_bytes(), 'app Info.plist')
    command(['codesign', '--verify', '--deep', '--strict', '--all-architectures', str(app)])
    entitlements = plist(command(['codesign', '-d', '--entitlements', '-', '--xml', str(app)]),
                         'signed entitlements')
    source = 'code-signature'
    if platform == 'simulator':
        executable = info.get('CFBundleExecutable')
        require(isinstance(executable, str) and executable and Path(executable).name == executable,
                'Invalid simulator executable name')
        embedded = simulator_entitlements((app / executable).read_bytes())
        if entitlements:
            for key in ('application-identifier', 'keychain-access-groups',
                        'com.apple.security.application-groups', 'get-task-allow'):
                require(entitlements.get(key) == embedded.get(key),
                        f'Signed and embedded simulator entitlements disagree: {key}')
        entitlements, source = embedded, 'Mach-O __TEXT,__entitlements (all architectures)'
    return {**identity(info, entitlements, platform, bundle_id), 'entitlement_source': source}


def compatible(candidate, baseline):
    for field in ('bundle_id', 'platform', 'application_identifier', 'default_group'):
        require(candidate[field] == baseline[field],
                f'Keychain compatibility failed: {field} changed; preserve the known-good identity')
    require(set(baseline['access_groups']).issubset(candidate['access_groups']),
            'Keychain compatibility failed: an existing access group was removed')


def installed_app(simulator, bundle_id, simulator_set=None):
    # Never treat a failed simulator command as "not installed".
    simctl = ['xcrun', 'simctl'] + (['--set', str(simulator_set)] if simulator_set else [])
    raw = command([*simctl, 'listapps', simulator])
    apps = plist(command(['plutil', '-convert', 'xml1', '-o', '-', '-'], data=raw),
                 'simulator app inventory')
    if bundle_id not in apps:
        return None
    path = command([*simctl, 'get_app_container', simulator, bundle_id, 'app']).decode().strip()
    require(path and Path(path).is_dir(), 'Installed app path is unavailable')
    return Path(path)


def baseline_for(simulator, bundle_id, baseline_app=None, simulator_set=None):
    if baseline_app:
        return inspect_app(baseline_app, 'simulator', bundle_id)
    app = installed_app(simulator, bundle_id, simulator_set)
    if app is None:
        return None
    try:
        return inspect_app(app, 'simulator', bundle_id)
    except SigningError as error:
        raise SigningError(f'Installed app has no verifiable Keychain identity ({error}). Restore using '
                           '--baseline-app pointing to a known-good signed app; do not erase data.') from error


def check_profile(profile, candidate, team_id):
    entitlements = candidate['entitlements']
    require(profile.get('TeamIdentifier') == [team_id], 'Provisioning profile Team ID mismatch')
    require(entitlements.get('com.apple.developer.team-identifier') == team_id,
            'Signed Team ID mismatch')
    expiry = profile.get('ExpirationDate')
    require(isinstance(expiry, datetime) and expiry.replace(tzinfo=timezone.utc) > datetime.now(timezone.utc),
            'Provisioning profile is missing an expiry or has expired')
    allowed = profile.get('Entitlements', {})
    app_pattern = allowed.get('application-identifier')
    require(isinstance(app_pattern, str) and fnmatch.fnmatchcase(candidate['application_identifier'], app_pattern),
            'Provisioning profile does not authorize this application-identifier')
    patterns = allowed.get('keychain-access-groups', [])
    require(isinstance(patterns, list) and all(isinstance(x, str) for x in patterns),
            'Invalid provisioning profile access groups')
    for group in entitlements.get('keychain-access-groups', []):
        require(any(fnmatch.fnmatchcase(group, pattern) for pattern in patterns),
                'Provisioning profile does not authorize a signed Keychain access group')
    allowed_app_groups = allowed.get('com.apple.security.application-groups', [])
    require(isinstance(allowed_app_groups, list), 'Invalid provisioning profile app groups')
    require(set(entitlements.get('com.apple.security.application-groups', [])).issubset(allowed_app_groups),
            'Provisioning profile does not authorize a signed app group')
    require(entitlements.get('get-task-allow', False) == allowed.get('get-task-allow', False),
            'Debug entitlement does not match provisioning profile')


def check_app(app, platform, bundle_id, *, baseline=None, expected=None, team_id=None):
    candidate = inspect_app(app, platform, bundle_id)
    if expected is not None:
        expected_identity = identity({'CFBundleIdentifier': bundle_id,
            'CFBundleSupportedPlatforms': ['iPhoneSimulator' if platform == 'simulator' else 'iPhoneOS']},
            expected, platform, bundle_id)
        compatible(candidate, expected_identity)
    if baseline is not None:
        compatible(candidate, baseline)
    if platform == 'device':
        require(team_id, 'Device verification requires the Apple Team ID')
        profile_path = Path(app) / 'embedded.mobileprovision'
        require(profile_path.is_file(), 'Device app has no embedded provisioning profile')
        profile = plist(command(['security', 'cms', '-D', '-i', str(profile_path)]), 'provisioning profile')
        check_profile(profile, candidate, team_id)
        # A matching plist alone is insufficient: the actual signer must be
        # one of the profile's authorized certificates (and cannot be ad hoc).
        with tempfile.TemporaryDirectory(prefix='ios-signing-certificate-') as directory:
            prefix = str(Path(directory) / 'signer-')
            command(['codesign', '-d', '--extract-certificates=' + prefix, str(app)])
            certificate = Path(prefix + '0')
            require(certificate.is_file() and certificate.read_bytes() in profile.get('DeveloperCertificates', []),
                    'Actual signing certificate is not authorized by the provisioning profile')
    return candidate


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app', type=Path)
    parser.add_argument('--platform', choices=['simulator', 'device'], required=True)
    parser.add_argument('--bundle-id', required=True)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--simulator', help='Read the installed app as the compatibility baseline')
    source.add_argument('--baseline-app', type=Path, help='Known-good previously signed app, including recovery')
    source.add_argument('--new-installation', action='store_true', help='Explicitly verify a new device installation')
    parser.add_argument('--simulator-set', type=Path, help='Dedicated CoreSimulator device set; requires --simulator')
    parser.add_argument('--team-id')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    require(not args.simulator or args.platform == 'simulator', '--simulator requires simulator platform')
    require(not args.new_installation or args.platform == 'device', 'Simulator checks must inspect the destination')
    require(not args.simulator_set or args.simulator, '--simulator-set requires --simulator')
    baseline = None
    if args.simulator:
        baseline = baseline_for(args.simulator, args.bundle_id, simulator_set=args.simulator_set)
    elif args.baseline_app:
        baseline = inspect_app(args.baseline_app, args.platform, args.bundle_id)
    expected = None
    if args.platform == 'simulator' and baseline is None:
        require(args.bundle_id in {*BUNDLE_IDS.values(), 'com.rocento.preview.reactnative'}, 'Unknown simulator merchant identity')
        app_id = 'local.rocento.' + args.bundle_id
        expected = {'application-identifier': app_id, 'keychain-access-groups': [app_id], 'get-task-allow': True}
    result = check_app(args.app, args.platform, args.bundle_id, baseline=baseline,
                       expected=expected, team_id=args.team_id)
    result['baseline_checked'] = baseline is not None
    if args.report:
        args.report.write_text(json.dumps(result, indent=2) + '\n')
    print('iOS signature and Keychain identity checks passed' +
          (' against the existing identity' if baseline else ' for a new installation'))


if __name__ == '__main__':
    try:
        main()
    except (SigningError, OSError) as error:
        print(f'iOS signing check failed: {error}', file=sys.stderr)
        sys.exit(1)
