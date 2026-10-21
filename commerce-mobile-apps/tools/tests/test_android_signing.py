"""Signing failures must never reach installation or a data-reset fallback."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('android_signing', TOOLS / 'check_android_signing.py')
signing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(signing)
PACKAGE = 'com.rocento.grocery'
CERT = 'a' * 64
OTHER = 'b' * 64
MANIFEST = '''N: android=http://schemas.android.com/apk/res/android
  E: manifest (line=2)
    A: android:versionCode(0x0101021b)=(type 0x10)0x4
    A: package="com.rocento.grocery" (Raw: "com.rocento.grocery")
    E: application (line=5)
      A: android:debuggable(0x0101000f)=(type 0x12)0xffffffff
      E: activity (line=7)
        A: android:name(0x01010003)="com.rocento.mobile.MainActivity"
'''
SIGNATURE = f'Verifies\nNumber of signers: 1\nSigner #1 certificate SHA-256 digest: {CERT}\n'


def identity(**values):
    return {'package_id': PACKAGE, 'version_code': 4, 'certificate_sha256': CERT,
            'debuggable': False, 'instrumentation_target': None, 'apk_sha256': 'c' * 64, **values}


class FakeTools:
    aapt = Path('/sdk/aapt')
    apksigner = Path('/sdk/apksigner')
    adb = Path('/sdk/adb')

    def __init__(self, *, inventory=None, paths=None, failure=None):
        self.calls = []
        self.inventory = inventory if inventory is not None else f'package:android\npackage:{PACKAGE}'
        self.paths = paths if paths is not None else 'package:/data/app/merchant/base.apk'
        self.failure = failure

    def device(self, serial, *args):
        self.calls.append((serial, *args))
        if self.failure == args[0]:
            raise signing.SigningError('device unavailable')
        if args == ('get-state',):
            return 'device'
        if args == ('shell', 'am', 'get-current-user'):
            return '0'
        if args == ('shell', 'pm', 'list', 'packages', '-u'):
            return self.inventory
        if args[:3] == ('shell', 'pm', 'path'):
            return self.paths
        if args[0] == 'pull':
            Path(args[-1]).write_bytes(b'installed APK')
            return ''
        if args[0] == 'install':
            if not Path(args[-1]).is_file():
                raise AssertionError('missing verified snapshot')
            return 'Success'
        raise AssertionError(args)


class AndroidSigningTests(unittest.TestCase):
    def test_agp_test_apk_without_version_defaults_to_zero(self):
        tree = '\n'.join(x for x in MANIFEST.splitlines() if 'android:versionCode' not in x)
        tree += '\n    E: instrumentation (line=9)\n      A: android:targetPackage(0x01010021)="com.rocento.grocery"\n'
        self.assertEqual(signing.manifest(tree)['version_code'], 0)

    def test_manifest_scope_and_long_version(self):
        value = signing.manifest(MANIFEST.replace('    A: package=',
            '    A: android:versionCodeMajor(0x01010576)=(type 0x10)0x2\n    A: package='))
        self.assertEqual(value['package_id'], PACKAGE)
        self.assertEqual(value['version_code'], 2 * 2**32 + 4)
        self.assertTrue(value['debuggable'])

    def test_shared_uid_and_split_manifests_rejected(self):
        for attr in ['android:sharedUserId="shared.uid"', 'android:sharedUserMaxSdkVersion=(type 0x10)0x20',
                     'split="config.en"', 'android:isFeatureSplit=(type 0x12)0xffffffff']:
            with self.subTest(attr=attr), self.assertRaises(signing.SigningError):
                signing.manifest(MANIFEST.replace('    E: application', '    A: ' + attr + '\n    E: application'))

    def test_missing_and_duplicate_manifest_fields_rejected(self):
        for tree in ['', MANIFEST.replace('android:versionCode', 'android:unknown'),
                     MANIFEST.replace('    E: application', '    A: package="other.app"\n    E: application')]:
            with self.subTest(tree=tree), self.assertRaises(signing.SigningError):
                signing.manifest(tree)

    def test_compatible_standalone_and_builder_update(self):
        signing.compatible(identity(version_code=5), identity())
        signing.compatible(identity(), identity())

    def test_certificate_package_target_and_downgrade_rejected(self):
        for values in [{'certificate_sha256': OTHER}, {'package_id': 'com.rocento.pharmacy'},
                       {'version_code': 3}, {'instrumentation_target': 'other.app'}]:
            with self.subTest(values=values), self.assertRaises(signing.SigningError):
                signing.compatible(identity(**values), identity())

    def test_fingerprint_requires_full_digest(self):
        self.assertEqual(signing.fingerprint(':'.join(['AA'] * 32)), CERT)
        for value in ['', 'abc', 'z' * 64, 'a' * 40]:
            with self.subTest(value=value), self.assertRaises(signing.SigningError):
                signing.fingerprint(value)

    def test_inspection_verifies_signature_before_manifest(self):
        with tempfile.NamedTemporaryFile(suffix='.apk') as apk:
            with patch.object(signing, 'command', side_effect=[SIGNATURE, MANIFEST]) as run:
                info = signing.inspect_apk(apk.name, FakeTools(), PACKAGE)
                self.assertEqual(info['certificate_sha256'], CERT)
                self.assertEqual(run.call_args_list[0].args[0][1], 'verify')
            with patch.object(signing, 'command', side_effect=signing.SigningError('bad signature')) as run:
                with self.assertRaises(signing.SigningError):
                    signing.inspect_apk(apk.name, FakeTools(), PACKAGE)
                self.assertEqual(run.call_count, 1)

    def test_multiple_unknown_or_stamp_only_signatures_rejected(self):
        signatures = [SIGNATURE.replace('signers: 1', 'signers: 2'), '',
                      SIGNATURE.replace('Signer #1 certificate', 'Source Stamp Signer certificate'),
                      SIGNATURE + f'Signer #2 certificate SHA-256 digest: {OTHER}\n']
        with tempfile.NamedTemporaryFile(suffix='.apk') as apk:
            for value in signatures:
                with self.subTest(value=value), patch.object(signing, 'command', return_value=value):
                    with self.assertRaises(signing.SigningError):
                        signing.inspect_apk(apk.name, FakeTools(), PACKAGE)

    def test_wrong_merchant_rejected(self):
        with tempfile.NamedTemporaryFile(suffix='.apk') as apk:
            with patch.object(signing, 'command', side_effect=[SIGNATURE, MANIFEST]):
                with self.assertRaisesRegex(signing.SigningError, 'package'):
                    signing.inspect_apk(apk.name, FakeTools(), 'com.rocento.pharmacy')

    def test_verified_absence_is_distinct_from_lookup_failure(self):
        tools = FakeTools(inventory='package:android\npackage:com.rocento.grocery.test')
        self.assertEqual(signing.installed_identity(tools, 'emulator-1', PACKAGE), (None, '0'))
        for tools in [FakeTools(failure='get-state'), FakeTools(failure='shell'),
                      FakeTools(inventory=''), FakeTools(inventory='Error: denied')]:
            with self.subTest(tools=tools), self.assertRaises(signing.SigningError):
                signing.installed_identity(tools, 'emulator-1', PACKAGE)

    def test_retained_split_or_unreadable_installed_app_fails_closed(self):
        for tools in [FakeTools(paths=''), FakeTools(paths='package:/base.apk\npackage:/split.apk'),
                      FakeTools(failure='pull')]:
            with self.subTest(tools=tools), self.assertRaises(signing.SigningError):
                signing.installed_identity(tools, 'emulator-1', PACKAGE)

    def test_installed_apk_is_verified_and_temporary_copy_removed(self):
        paths = []
        def inspect(apk, tools, package):
            paths.append(apk)
            self.assertEqual(apk.read_bytes(), b'installed APK')
            return identity()
        with patch.object(signing, 'inspect_apk', side_effect=inspect):
            self.assertEqual(signing.installed_identity(FakeTools(), 'emulator-1', PACKAGE), (identity(), '0'))
        self.assertFalse(paths[0].exists())

    def test_release_and_owner_pin_checked(self):
        for candidate, kwargs in [(identity(debuggable=True), {'release': True}),
                                  (identity(), {'expected_cert': OTHER})]:
            with patch.object(signing, 'inspect_apk', return_value=candidate):
                with self.assertRaises(signing.SigningError):
                    signing.verify('apk', FakeTools(), PACKAGE, **kwargs)

    def test_offline_baseline_and_device_are_both_checked(self):
        with patch.object(signing, 'inspect_apk', side_effect=[identity(), identity()]), \
                patch.object(signing, 'installed_identity', return_value=(identity(certificate_sha256=OTHER), '0')):
            with self.assertRaisesRegex(signing.SigningError, 'certificate'):
                signing.verify('apk', FakeTools(), PACKAGE, baseline_apk='prior', serial='emulator-1')

    def test_disconnected_or_unauthorized_device_is_not_skipped(self):
        for devices in ['List of devices attached\n', 'List of devices attached\none\toffline\n',
                        'List of devices attached\none\tdevice\ntwo\tunauthorized\n']:
            with patch.object(signing, 'command', return_value=devices):
                with self.assertRaises(signing.SigningError):
                    signing.connected_devices(FakeTools())
        with patch.object(signing, 'command', return_value='List of devices attached\none\tdevice\ntwo\tdevice\n'):
            self.assertEqual(signing.connected_devices(FakeTools()), ['one', 'two'])

    def test_any_preflight_failure_prevents_installation(self):
        for error in ['signature', 'certificate', 'package', 'downgrade', 'lookup']:
            tools = FakeTools()
            with tempfile.NamedTemporaryFile(suffix='.apk') as apk, \
                    patch.object(signing, 'verify', side_effect=signing.SigningError(error)):
                with self.assertRaises(signing.SigningError):
                    signing.checked_install(apk.name, tools, PACKAGE, 'emulator-1')
                self.assertEqual(tools.calls, [])

    def test_install_uses_verified_snapshot_and_replace_without_reset(self):
        tools = FakeTools()
        with tempfile.NamedTemporaryFile(suffix='.apk') as apk:
            Path(apk.name).write_bytes(b'original')
            def verify(snapshot, *args, **kwargs):
                self.assertEqual(snapshot.read_bytes(), b'original')
                Path(apk.name).write_bytes(b'concurrent build')
                return {**identity(), 'android_user': '0'}
            with patch.object(signing, 'verify', side_effect=verify):
                signing.checked_install(apk.name, tools, PACKAGE, 'emulator-1')
            self.assertEqual(tools.calls[0][1:5], ('install', '-r', '--user', '0'))
            self.assertNotEqual(tools.calls[0][-1], apk.name)
            self.assertEqual(len(tools.calls), 1)
            self.assertFalse(Path(tools.calls[0][-1]).exists())

    def test_install_failure_never_uninstalls_or_clears(self):
        tools = FakeTools(failure='install')
        with tempfile.NamedTemporaryFile() as apk, \
                patch.object(signing, 'verify', return_value={**identity(), 'android_user': '0'}):
            with self.assertRaises(signing.SigningError):
                signing.checked_install(apk.name, tools, PACKAGE, 'emulator-1')
        self.assertEqual(len(tools.calls), 1)
        self.assertEqual(tools.calls[0][1], 'install')

    def test_default_cli_checks_without_installing(self):
        with patch.object(sys, 'argv', ['check', 'app.apk', '--flavor', 'rocento', '--serial', 'emulator-1']), \
                patch.object(signing, 'Tools', return_value=FakeTools()), \
                patch.object(signing, 'verify', return_value=identity()) as verify, \
                patch.object(signing, 'checked_install') as install:
            signing.main()
            self.assertEqual(verify.call_args.args[2], PACKAGE)
            install.assert_not_called()

    def test_new_offline_install_requires_owner_pin(self):
        with patch.object(sys, 'argv', ['check', 'app.apk', '--flavor', 'rocento', '--new-installation']):
            with self.assertRaisesRegex(signing.SigningError, 'expected-cert'):
                signing.main()

    def test_test_apk_target_and_signer_checked_before_gradle(self):
        for test in [identity(instrumentation_target='wrong.app'),
                     identity(instrumentation_target=PACKAGE, certificate_sha256=OTHER)]:
            with patch.object(sys, 'argv', ['check', 'app.apk', '--flavor', 'rocento',
                                         '--serial', 'emulator-1', '--test-apk', 'test.apk']), \
                    patch.object(signing, 'Tools', return_value=FakeTools()), \
                    patch.object(signing, 'verify', side_effect=[identity(), test]):
                with self.assertRaises(signing.SigningError):
                    signing.main()

    def test_tool_nonzero_exit_is_not_success(self):
        with patch.object(signing.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, 'partial', 'failed')):
            with self.assertRaises(signing.SigningError):
                signing.command(['adb', 'devices'])


class ReleaseScriptTests(unittest.TestCase):
    """Exercise Bash argument construction and the final checker as one flow."""
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        sdk = self.root / 'sdk/build-tools/36.0.0'
        sdk.mkdir(parents=True)
        fake = '''#!/usr/bin/env python3
import os, pathlib, shutil, sys
tool, args = pathlib.Path(sys.argv[0]).name, sys.argv[1:]
if tool == 'aapt':
    print("package: name='com.rocento.grocery'" if args[1] == 'badging' else os.environ['FIXTURE_MANIFEST'])
elif tool == 'zipalign':
    if '-f' in args: shutil.copyfile(args[-2], args[-1])
elif tool == 'apksigner':
    if args[0] == 'sign': shutil.copyfile(args[-1], args[args.index('--out')+1])
    else:
        cert = ('b' if pathlib.Path(args[-1]).read_bytes() == b'other signer' else 'a') * 64
        print('Number of signers: 1\\nSigner #1 certificate SHA-256 digest: ' + cert)
'''
        for name in ('aapt', 'zipalign', 'apksigner'):
            path = sdk / name
            path.write_text(fake)
            path.chmod(0o755)
        self.unsigned = self.root / 'unsigned.apk'
        self.unsigned.write_bytes(b'fixture APK')
        self.key = self.root / 'fixture.keystore'
        self.key.write_bytes(b'not a private key')
        self.env = {k: v for k, v in os.environ.items() if not k.startswith('ROCENTO_ANDROID_')}
        self.env.update({'ANDROID_HOME': str(self.root / 'sdk'), 'ROCENTO_ANDROID_KEYSTORE': str(self.key),
                         'ROCENTO_ANDROID_KEY_ALIAS': 'fixture', 'ROCENTO_ANDROID_STORE_PASSWORD': 'fixture',
                         'ROCENTO_ANDROID_KEY_PASSWORD': 'fixture',
                         'FIXTURE_MANIFEST': MANIFEST.replace('0xffffffff', '0x0')})

    def run_script(self, **env):
        return subprocess.run(['bash', str(TOOLS / 'sign_android_device.sh'), str(self.unsigned), str(self.root / 'out')],
                              env={**self.env, **env}, capture_output=True, text=True)

    def test_upgrade_without_optional_pin_passes_on_macos_bash(self):
        result = self.run_script(ROCENTO_ANDROID_BASELINE_APK=str(self.unsigned))
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads((self.root / 'out/signing-check.json').read_text())
        self.assertTrue(report[0]['baseline_checked'])
        self.assertTrue((self.root / 'out/SHA256SUMS').exists())

    def test_new_install_with_owner_pin(self):
        result = self.run_script(ROCENTO_ANDROID_NEW_INSTALLATION='1', ROCENTO_ANDROID_CERT_SHA256=CERT)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(json.loads((self.root / 'out/signing-check.json').read_text())[0]['baseline_checked'])

    def test_wrong_signer_fails_without_success_checksum(self):
        prior = self.root / 'prior.apk'
        prior.write_bytes(b'other signer')
        result = self.run_script(ROCENTO_ANDROID_BASELINE_APK=str(prior))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('certificate changed', result.stderr)
        self.assertFalse((self.root / 'out/SHA256SUMS').exists())

    def test_missing_or_conflicting_baseline_fails_before_signing(self):
        for env in [{}, {'ROCENTO_ANDROID_BASELINE_APK': str(self.unsigned), 'ROCENTO_ANDROID_NEW_INSTALLATION': '1'}]:
            with self.subTest(env=env):
                self.assertNotEqual(self.run_script(**env).returncode, 0)
                self.assertFalse((self.root / 'out').exists())


if __name__ == '__main__':
    unittest.main()
