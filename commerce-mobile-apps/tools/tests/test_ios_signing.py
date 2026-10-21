"""Signing regressions: invalid artifacts and inaccessible baselines never reach install."""
import argparse
from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import plistlib
import subprocess
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))
import check_ios_signing as signing
import build_ios_simulator as builder

BUNDLE = 'com.rocento.grocery'
APP_ID = 'local.rocento.' + BUNDLE
TEAM = 'ABCDEFGHIJ'


def info(platform='simulator'):
    return {'CFBundleIdentifier': BUNDLE, 'CFBundleExecutable': 'App',
            'CFBundleSupportedPlatforms': ['iPhoneSimulator' if platform == 'simulator' else 'iPhoneOS']}


def entitlements(app_id=APP_ID):
    return {'application-identifier': app_id, 'keychain-access-groups': [app_id], 'get-task-allow': True}


def snapshot(values=None):
    return signing.identity(info(), values or entitlements(), 'simulator', BUNDLE)


def macho(values):
    payload = plistlib.dumps(values)
    offset = 32 + 72 + 80
    header = struct.pack('<IiiIIIII', 0xfeedfacf, 0x100000c, 0, 2, 1, 152, 0, 0)
    segment = struct.pack('<II16sQQQQiiII', 25, 152, b'__TEXT', 0, offset + len(payload),
                          0, offset + len(payload), 7, 5, 1, 0)
    section = struct.pack('<16s16sQQIIIIIIII', b'__entitlements', b'__TEXT', offset, len(payload),
                          offset, 0, 0, 0, 0, 0, 0, 0)
    return header + segment + section + payload


def universal(one, two):
    first = struct.pack('>iiIII', 0x100000c, 0, 48, len(one), 0)
    second = struct.pack('>iiIII', 0x1000007, 0, 48 + len(one), len(two), 0)
    return struct.pack('>II', 0xcafebabe, 2) + first + second + one + two


class IdentityTests(unittest.TestCase):
    def test_standalone_and_studio_share_identity(self):
        self.assertEqual(signing.BUNDLE_IDS['Rocento'], signing.BUNDLE_IDS['RocentoStudio'])
        signing.compatible(snapshot(), snapshot())

    def test_empty_or_unresolved_entitlements_fail(self):
        for values in ({}, entitlements('$(AppIdentifierPrefix)' + BUNDLE),
                       entitlements('prefix.*'), {'application-identifier': APP_ID}):
            with self.subTest(values=values), self.assertRaises(signing.SigningError):
                signing.identity(info(), values, 'simulator', BUNDLE)

    def test_wrong_bundle_or_platform_fails(self):
        for values in ({**info(), 'CFBundleIdentifier': 'com.rocento.electronics'}, info('device')):
            with self.subTest(values=values), self.assertRaises(signing.SigningError):
                signing.identity(values, entitlements(), 'simulator', BUNDLE)

    def test_prefix_change_fails(self):
        with self.assertRaisesRegex(signing.SigningError, 'application_identifier changed'):
            signing.compatible(snapshot(entitlements('other.' + BUNDLE)), snapshot())

    def test_default_group_reordering_and_group_removal_fail(self):
        baseline = snapshot({**entitlements(), 'keychain-access-groups': [APP_ID, 'local.extra']})
        for groups in (['local.extra', APP_ID], [APP_ID]):
            with self.subTest(groups=groups), self.assertRaises(signing.SigningError):
                signing.compatible(snapshot({**entitlements(), 'keychain-access-groups': groups}), baseline)

    def test_adding_group_preserves_default_and_access(self):
        candidate = snapshot({**entitlements(), 'keychain-access-groups': [APP_ID, 'local.extra']})
        signing.compatible(candidate, snapshot())

    def test_simulator_requires_debug_entitlement(self):
        with self.assertRaisesRegex(signing.SigningError, 'debug entitlement'):
            snapshot({**entitlements(), 'get-task-allow': False})

    def test_device_can_use_implicit_app_id_group(self):
        values = {'application-identifier': TEAM + '.' + BUNDLE}
        result = signing.identity(info('device'), values, 'device', BUNDLE)
        self.assertEqual(result['default_group'], TEAM + '.' + BUNDLE)

    def test_simulator_prefix_rejected_for_device(self):
        with self.assertRaisesRegex(signing.SigningError, 'Simulator identity'):
            signing.identity(info('device'), entitlements(), 'device', BUNDLE)

    def test_profiles_authorize_actual_identity_and_groups(self):
        app_id = 'OLDPREFIX1.' + BUNDLE  # App ID prefix need not equal Team ID.
        candidate = signing.identity(info('device'), {
            **entitlements(app_id), 'com.apple.developer.team-identifier': TEAM}, 'device', BUNDLE)
        profile = {'TeamIdentifier': [TEAM], 'ExpirationDate': datetime.now(timezone.utc) + timedelta(days=1),
                   'Entitlements': {'application-identifier': 'OLDPREFIX1.*',
                     'keychain-access-groups': ['OLDPREFIX1.*'], 'get-task-allow': True}}
        signing.check_profile(profile, candidate, TEAM)
        invalid = [
            {**profile, 'TeamIdentifier': ['WRONGTEAM1']},
            {**profile, 'ExpirationDate': datetime.now(timezone.utc) - timedelta(days=1)},
            {**profile, 'Entitlements': {**profile['Entitlements'], 'application-identifier': 'WRONG.*'}},
            {**profile, 'Entitlements': {**profile['Entitlements'], 'keychain-access-groups': ['WRONG.*']}},
            {**profile, 'Entitlements': {**profile['Entitlements'], 'get-task-allow': False}},
        ]
        for value in invalid:
            with self.subTest(profile=value), self.assertRaises(signing.SigningError):
                signing.check_profile(value, candidate, TEAM)

    def test_simulator_lookup_failure_is_not_new_installation(self):
        with patch.object(signing, 'command', side_effect=signing.SigningError('Lookup failed')):
            with self.assertRaises(signing.SigningError):
                signing.baseline_for('device', BUNDLE)

    def test_verified_absence_is_new_installation(self):
        with patch.object(signing, 'command', side_effect=[b'inventory', plistlib.dumps({})]):
            self.assertIsNone(signing.installed_app('device', BUNDLE))

    def test_broken_installed_app_requires_known_good_baseline(self):
        with patch.object(signing, 'installed_app', return_value=Path('/existing.app')), \
             patch.object(signing, 'inspect_app', side_effect=signing.SigningError('No entitlements')):
            with self.assertRaisesRegex(signing.SigningError, 'known-good signed app'):
                signing.baseline_for('device', BUNDLE)

    def test_simulator_embedded_entitlements_with_empty_signature_plist(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory)
            (app / 'Info.plist').write_bytes(plistlib.dumps(info()))
            (app / 'App').write_bytes(macho(entitlements()))
            with patch.object(signing, 'command', side_effect=[b'', plistlib.dumps({})]):
                result = signing.inspect_app(app, 'simulator', BUNDLE)
                self.assertEqual(result['default_group'], APP_ID)
                self.assertIn('all architectures', result['entitlement_source'])

    def test_simulator_signature_and_embedded_disagreement_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory)
            (app / 'Info.plist').write_bytes(plistlib.dumps(info()))
            (app / 'App').write_bytes(macho(entitlements()))
            with patch.object(signing, 'command', side_effect=[b'', plistlib.dumps(entitlements('wrong.' + BUNDLE))]):
                with self.assertRaisesRegex(signing.SigningError, 'disagree'):
                    signing.inspect_app(app, 'simulator', BUNDLE)

    def test_all_simulator_architectures_must_agree(self):
        good = macho(entitlements())
        self.assertEqual(signing.simulator_entitlements(universal(good, good)), entitlements())
        with self.assertRaisesRegex(signing.SigningError, 'different entitlements'):
            signing.simulator_entitlements(universal(good, macho(entitlements('wrong.' + BUNDLE))))

    def test_missing_or_malformed_embedded_entitlements_fail(self):
        for binary in (b'', macho(entitlements())[:180],
                       macho(entitlements()).replace(b'__entitlements', b'__othersection'),
                       universal(macho(entitlements()), b'not Mach-O')):
            with self.subTest(binary=binary[:4]), self.assertRaises(signing.SigningError):
                signing.simulator_entitlements(binary)

    def test_signature_failure_prevents_entitlement_acceptance(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / 'App.app'; app.mkdir()
            (app / 'Info.plist').write_bytes(plistlib.dumps(info()))
            with patch.object(signing, 'command', side_effect=signing.SigningError('Invalid signature')):
                with self.assertRaisesRegex(signing.SigningError, 'Invalid signature'):
                    signing.inspect_app(app, 'simulator', BUNDLE)

    def test_device_signer_must_be_in_profile(self):
        values = {**entitlements(TEAM + '.' + BUNDLE), 'com.apple.developer.team-identifier': TEAM}
        candidate = signing.identity(info('device'), values, 'device', BUNDLE)
        profile = {'TeamIdentifier': [TEAM], 'ExpirationDate': datetime.now(timezone.utc) + timedelta(days=1),
                   'Entitlements': values, 'DeveloperCertificates': [b'authorized']}
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory); (app / 'embedded.mobileprovision').touch()
            def fake_command(args):
                if args[0] == 'security': return plistlib.dumps(profile)
                Path(args[2].split('=', 1)[1] + '0').write_bytes(b'unauthorized')
                return b''
            with patch.object(signing, 'inspect_app', return_value=candidate), \
                 patch.object(signing, 'command', side_effect=fake_command):
                with self.assertRaisesRegex(signing.SigningError, 'Actual signing certificate'):
                    signing.check_app(app, 'device', BUNDLE, team_id=TEAM)


class PrivateDeviceSetTests(unittest.TestCase):
    def test_destination_inventory_uses_private_device_set(self):
        with patch.object(signing, 'command', side_effect=[b'raw', plistlib.dumps({})]) as command:
            self.assertIsNone(signing.baseline_for('device', BUNDLE, simulator_set='/private/worker/devices'))
            self.assertEqual(command.call_args_list[0].args[0],
                             ['xcrun', 'simctl', '--set', '/private/worker/devices', 'listapps', 'device'])

    def test_inventory_failure_cannot_be_treated_as_new_install(self):
        with patch.object(signing, 'command', side_effect=signing.SigningError('unavailable')):
            with self.assertRaises(signing.SigningError):
                signing.baseline_for('device', BUNDLE, simulator_set='/private/worker/devices')


class BuildGateTests(unittest.TestCase):
    def run_build(self, mode, *, install=True, baseline=None):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'new-build'
            args = argparse.Namespace(scheme='RocentoStudio', simulator='test-device', output=output,
                                      baseline_app=None, build_for_testing=True, install=install)
            calls = []
            def fake_process(command, **kwargs):
                calls.append(command)
                if command[0] == 'xcodebuild':
                    app = output / 'DerivedData/Build/Products/Debug-iphonesimulator/Rocento.app'
                    app.mkdir(parents=True)
                    (app / 'Info.plist').write_bytes(plistlib.dumps(info()))
                    values = entitlements()
                    if mode == 'empty': values = {}
                    if mode == 'prefix': values = entitlements('wrong.' + BUNDLE)
                    if mode == 'group': values['keychain-access-groups'] = ['wrong.default', APP_ID]
                    (app / 'App').write_bytes(macho(values))
                return subprocess.CompletedProcess(command, 0)
            def fake_signing(command, **kwargs):
                if command[1] == '--verify':
                    if mode == 'unsigned': raise signing.SigningError('Invalid signature')
                    return b''
                values = entitlements()
                if mode == 'empty': values = {}
                if mode == 'prefix': values = entitlements('wrong.' + BUNDLE)
                if mode == 'group': values['keychain-access-groups'] = ['wrong.default', APP_ID]
                return plistlib.dumps(values)
            with patch.object(builder, 'baseline_for', return_value=baseline), \
                 patch.object(builder.subprocess, 'run', side_effect=fake_process), \
                 patch.object(signing, 'command', side_effect=fake_signing):
                if mode == 'valid':
                    builder.build(args)
                    self.assertTrue((output / 'signing-check.json').is_file())
                else:
                    with self.assertRaises(signing.SigningError): builder.build(args)
                    self.assertFalse((output / 'signing-check.json').exists())
            installs = [c for c in calls if c[:3] == ['xcrun', 'simctl', 'install']]
            self.assertEqual(len(installs), 1 if mode == 'valid' and install else 0)

    def test_invalid_builds_never_install(self):
        for mode in ('unsigned', 'empty', 'prefix', 'group'):
            with self.subTest(mode=mode): self.run_build(mode)

    def test_valid_upgrade_installs_after_validation(self):
        self.run_build('valid', baseline=snapshot())

    def test_build_only_never_installs(self):
        self.run_build('valid', install=False)

    def test_preflight_failure_never_builds_or_installs(self):
        args = argparse.Namespace(scheme='RocentoStudio', simulator='test-device',
                                  output=Path('/unused-signing-test'), baseline_app=None)
        with patch.object(builder, 'baseline_for', side_effect=signing.SigningError('Lookup failed')), \
             patch.object(builder.subprocess, 'run') as process:
            with self.assertRaises(signing.SigningError): builder.build(args)
            process.assert_not_called()


if __name__ == '__main__':
    unittest.main()
