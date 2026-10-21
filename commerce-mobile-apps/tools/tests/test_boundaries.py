"""Regression checks for source, build wiring, and packaged builder isolation."""
import importlib.util
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import unittest
import zipfile

TOOLS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('boundaries', TOOLS / 'check_boundaries.py')
boundaries = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundaries)


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.mobile = Path(self.temp.name)
        for root in boundaries.CORE_PATHS:
            (self.mobile / root).mkdir(parents=True)
        for name in ('ios/RocentoCore/Package.swift', 'android/core/build.gradle.kts',
                     'android/settings.gradle.kts', 'android/app/build.gradle.kts',
                     'tools/generate_xcode_project.py', 'ios/Storefront/Info.plist',
                     'react-native/App.tsx', 'react-native/index.ts', 'react-native/index.studio.ts',
                     'react-native/android/app/build.gradle', 'react-native/ios/Integrations/AppBuilder/StudioBootstrap.swift'):
            self.write(name, (boundaries.MOBILE / name).read_bytes())
        shutil.copytree(boundaries.MOBILE / 'ios/RocentoMobile.xcodeproj',
                        self.mobile / 'ios/RocentoMobile.xcodeproj')
        for path in (boundaries.MOBILE / 'ios/Storefront').glob('*.swift'):
            self.write('ios/Storefront/' + path.name, '')
        # Keep fixtures independent of concurrent application edits. The CLI
        # separately checks the actual checked-in project for generation drift.
        subprocess.run([boundaries.sys.executable,
                        str(self.mobile / 'tools/generate_xcode_project.py')],
                       check=True, capture_output=True)

    def write(self, name, data):
        path = self.mobile / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data.encode() if isinstance(data, str) else data)
        return path

    def test_current_sources_and_wiring_pass(self):
        boundaries.check_editor_dependencies(self.mobile)
        boundaries.check_sources(self.mobile)
        boundaries.check_build_wiring(self.mobile)

    def test_editor_dependencies_fail_in_every_platform_and_adapter(self):
        cases = {
            'ios/Storefront/Leak.swift': 'import RocentoAppsBuilderEditor',
            'ios/RocentoAppBuilder/Package.swift': '.package(path: "../../../commerce-web/apps/mobile-studio")',
            'android/app-builder/build.gradle.kts': 'implementation(project(":mobile-admin"))',
            'android/settings.gradle.kts': 'includeBuild("../../commerce-web/apps/mobile-studio")',
            'react-native/package.json': '{"dependencies":{"@rocento/mobile-admin":"workspace:*"}}',
            'react-native/package-lock.json': '{"resolved":"file:../../commerce-web/apps/mobile-studio"}',
            'react-native/tsconfig.json': '{"extends":"../../commerce-web/apps/mobile-studio/tsconfig.json"}',
            'react-native/metro.config.js': 'require("../../commerce-web/apps/mobile-studio")',
            'react-native/src/future/Leak.ts': 'export * from "@rocento/mobile-admin";',
            'shared/maps/Leak.js': 'import "../../../commerce-web/apps/mobile-studio/src/editor";',
        }
        for name, text in cases.items():
            with self.subTest(name=name):
                path = self.mobile / name
                previous = path.read_bytes() if path.exists() else None
                self.write(name, text)
                with self.assertRaisesRegex(ValueError, 'Editor dependency'):
                    boundaries.check_editor_dependencies(self.mobile)
                if previous is None:
                    path.unlink()
                else:
                    path.write_bytes(previous)

    def test_editor_guard_allows_contracts_native_delivery_and_standard_packages(self):
        self.write('ios/RocentoAppBuilder/Delivery.swift',
                   'import RocentoCore\nlet route = "/v1/mobile/config"')
        self.write('react-native/package-lock.json',
                   '{"resolved":"https://registry.npmjs.org/@react-native/debugger-frontend/-/package.tgz"}')
        self.write('shared/schema.json', '{"source":"backend/crates/domain-mobile/contract/v1"}')
        boundaries.check_editor_dependencies(self.mobile)

    def test_editor_symlink_cannot_bypass_guard(self):
        with tempfile.TemporaryDirectory() as external:
            (self.mobile / 'react-native/editor').symlink_to(external, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'External mobile symlink'):
                boundaries.check_editor_dependencies(self.mobile)

    def test_editor_dependency_in_project_generator_fails(self):
        self.write('tools/generate_xcode_project.py', 'source = "commerce-web/apps/mobile-studio"')
        with self.assertRaisesRegex(ValueError, 'Editor dependency'):
            boundaries.check_editor_dependencies(self.mobile)

    def test_new_flavor_java_and_shared_ios_roots_are_scanned(self):
        for name in ('android/app/src/rocento/java/Leak.java', 'ios/Shared/Leak.swift'):
            with self.subTest(name=name):
                path = self.write(name, 'import com.rocento.mobile.builder;')
                with self.assertRaisesRegex(ValueError, 'Builder dependency'):
                    boundaries.check_sources(self.mobile)
                path.unlink()

    def test_optional_adapters_are_allowed(self):
        for root in boundaries.OPTIONAL_PATHS:
            self.write(root + '/Adapter.swift', 'import RocentoAppBuilder')
        boundaries.check_sources(self.mobile)

    def test_react_native_entry_and_future_shared_roots_are_scanned(self):
        for name in ('react-native/App.tsx', 'react-native/src/future/transport.ts'):
            with self.subTest(name=name):
                path = self.write(name, 'fetch("/v1/mobile/config")')
                with self.assertRaisesRegex(ValueError, 'Builder dependency'):
                    boundaries.check_sources(self.mobile)
                path.unlink()

    def test_react_native_dependencies_and_bundles_are_not_source(self):
        for root in ('node_modules', 'dist', '.expo'):
            self.write(f'react-native/{root}/dependency.js', 'RocentoAppBuilder')
        boundaries.check_sources(self.mobile)

    def test_missing_source_root_fails(self):
        (self.mobile / boundaries.CORE_PATHS[-1]).rmdir()
        with self.assertRaisesRegex(ValueError, 'Missing required source root'):
            boundaries.check_sources(self.mobile)

    def test_core_dependency_fails(self):
        self.write('android/core/build.gradle.kts', 'implementation(project(":app-builder"))')
        with self.assertRaisesRegex(ValueError, 'Core must not depend'):
            boundaries.check_sources(self.mobile)

    def test_unconditional_gradle_link_fails(self):
        path = self.mobile / 'android/app/build.gradle.kts'
        path.write_text(path.read_text().replace('if (appBuilder) implementation', 'implementation'))
        with self.assertRaisesRegex(ValueError, 'must remain conditional'):
            boundaries.check_build_wiring(self.mobile)

    def test_changed_xcode_link_fails_without_rewriting_project(self):
        path = self.mobile / 'ios/RocentoMobile.xcodeproj/project.pbxproj'
        changed = path.read_text().replace('"productName" = "RocentoCore";', '"productName" = "RocentoAppBuilder";', 1)
        path.write_text(changed)
        with self.assertRaises(subprocess.CalledProcessError):
            boundaries.check_build_wiring(self.mobile)
        self.assertEqual(changed, path.read_text())

    def test_apk_scans_additional_dex_and_native_libraries(self):
        path = self.mobile / 'standalone.apk'
        for name in ('classes2.dex', 'lib/arm64-v8a/adapter.so'):
            with self.subTest(name=name):
                with zipfile.ZipFile(path, 'w') as apk:
                    apk.writestr('classes.dex', b'native commerce')
                    apk.writestr(name, b'v1/mobile/assets/private')
                with self.assertRaisesRegex(ValueError, 'Builder code found'):
                    boundaries.check_android(path)

    def test_ios_scans_extensionless_framework_binaries(self):
        self.write('Storefront.app/Info.plist', plistlib.dumps({'CFBundleExecutable': 'Storefront'}))
        self.write('Storefront.app/Storefront', bytes.fromhex('cffaedfe') + b'commerce')
        app = self.mobile / 'Storefront.app'
        boundaries.check_ios(app)
        self.write('Storefront.app/Frameworks/Adapter.framework/Adapter',
                   bytes.fromhex('cffaedfe') + b'RocentoAppBuilder')
        with self.assertRaisesRegex(ValueError, 'Builder code found'):
            boundaries.check_ios(app)

    def test_published_ios_allows_delivery_but_rejects_drafts(self):
        self.write('Rocento.app/Info.plist', plistlib.dumps({'CFBundleExecutable': 'Rocento'}))
        executable = self.write('Rocento.app/Rocento', b'RocentoAppBuilder v1/mobile/config')
        app = self.mobile / 'Rocento.app'
        boundaries.check_ios(app, published=True)
        for marker in (b'DraftPreviewRuntime', b'HTTPDraftPreviewTransport', b'v1/mobile/preview/',
                       b'preview-session-start', b'ROCENTO_PREVIEW_CODE'):
            executable.write_bytes(b'RocentoAppBuilder ' + marker)
            with self.assertRaisesRegex(ValueError, 'Forbidden code'):
                boundaries.check_ios(app, published=True)

    def test_studio_alias_reuses_canonical_target(self):
        schemes = self.mobile / 'ios/RocentoMobile.xcodeproj/xcshareddata/xcschemes'
        for name in ('Rocento', 'Electronics', 'Jewelry', 'Pharmacy'):
            self.assertEqual((schemes / (name + '.xcscheme')).read_bytes(),
                             (schemes / (name + 'Studio.xcscheme')).read_bytes())


if __name__ == '__main__':
    unittest.main()
