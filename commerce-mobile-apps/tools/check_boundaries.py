"""Enforce the optional builder boundary in source and standalone native artifacts."""
import argparse
import os
from pathlib import Path
import re
import subprocess
import sys
import zipfile

MOBILE = Path(__file__).resolve().parents[1]
FORBIDDEN = re.compile(r'RocentoAppBuilder|com\.rocento\.mobile\.builder|\b(?:EnrollmentClient|ConfigStore|AppBuilderIdentity|AppBuilderConfiguration|configBaseURL|configBase)\b|v1/mobile/')
CORE_PATHS = [
    'ios/RocentoCore/Sources/RocentoCore', 'ios/Storefront', 'ios/Integrations/Standalone',
    'android/core/src/main/java', 'android/app/src/main/java', 'android/app/src/standalone/java',
    'react-native/src/core', 'react-native/src/ui',
]
OPTIONAL_PATHS = [
    'react-native/src/integrations/appBuilder', 'react-native/ios/Integrations/AppBuilder',
    'react-native/android/app/src/studio',
    'ios/RocentoAppBuilder', 'ios/Integrations/AppBuilder',
    'android/app-builder', 'android/app/src/appBuilder', 'android/app/src/appBuilderAndroidTest',
]
BUILD_DIRECTORIES = {'.build', 'build', 'DerivedData', '.gradle', '.git', 'node_modules', '.expo', 'dist'}
SOURCE_SUFFIXES = {'.swift', '.kt', '.java', '.m', '.mm', '.h', '.xml', '.ts', '.tsx', '.js', '.mjs', '.cjs'}
EDITOR_REFERENCE = re.compile(
    r'(?<![\w-])(?:frontend|commerce-web/apps/mobile-studio)/|@rocento/mobile-admin\b|\bmobile-admin\b|'
    r'\bRocentoAppsBuilderEditor\b|\bcom\.rocento\.apps\.editor\b'
)
EDITOR_SUFFIXES = SOURCE_SUFFIXES | {
    '.kts', '.gradle', '.json', '.pbxproj', '.xcconfig', '.xcscheme',
    '.plist', '.py', '.sh', '.rb', '.lock', '.resolved', '.yaml', '.yml',
}


def check_editor_dependencies(mobile=MOBILE):
    """Editor implementation is forbidden even in optional delivery adapters.

    Scan manifests, lockfiles, bundler aliases and native project wiring as well
    as source. Versioned backend contracts and native delivery clients are allowed.
    Generated/vendor build trees are excluded; their owning manifests are scanned.
    """
    for platform in ('ios', 'android', 'react-native', 'shared'):
        for root, directories, files in os.walk(mobile / platform):
            for name in directories + files:
                path = Path(root) / name
                if path.is_symlink():
                    require(path.resolve().is_relative_to(mobile.resolve()),
                            f'External mobile symlink: {path.relative_to(mobile)}')
            directories[:] = [name for name in directories
                              if name not in BUILD_DIRECTORIES | {'Pods', '__pycache__', '.idea'}
                              and not name.startswith('dist-')
                              and not name.endswith('.xcresult')]
            for name in files:
                path = Path(root) / name
                if path.suffix not in EDITOR_SUFFIXES and name not in {'Podfile', 'Gemfile'}:
                    continue
                text = path.read_text().replace('\\\\', '/').replace('\\/', '/')
                match = EDITOR_REFERENCE.search(text)
                require(not match,
                        f'Editor dependency in {path.relative_to(mobile)}: '
                        f'{match.group() if match else ""}')
    # The native project generator is build input too (not editor output).
    generator = mobile / 'tools/generate_xcode_project.py'
    require(not EDITOR_REFERENCE.search(generator.read_text()),
            'Editor dependency in native project generator')


def require(condition, message):
    # Assertions can be disabled with python -O; architecture checks cannot.
    if not condition:
        raise ValueError(message)


def check_sources(mobile=MOBILE):
    for relative in CORE_PATHS:
        require((mobile / relative).is_dir(), f'Missing required source root: {relative}')
    # Discover every native source root, including Java, flavor/debug source sets,
    # tests and future shared directories. Only explicit optional adapters are exempt.
    for platform in ('ios', 'android', 'react-native'):
        for root, directories, files in os.walk(mobile / platform):
            directories[:] = [name for name in directories
                              if name not in BUILD_DIRECTORIES and not name.endswith('.xcresult')]
            for name in files:
                path = Path(root) / name
                relative = path.relative_to(mobile)
                if any(relative.is_relative_to(optional) for optional in OPTIONAL_PATHS):
                    continue
                if path.suffix not in SOURCE_SUFFIXES or not path.is_file():
                    continue
                match = FORBIDDEN.search(path.read_text())
                if match:
                    raise ValueError(f'Builder dependency in {relative}: {match.group()}')
    for relative in ['ios/RocentoCore/Package.swift', 'android/core/build.gradle.kts']:
        text = (mobile / relative).read_text()
        require(not re.search(r'RocentoAppBuilder|app-builder', text), f'Core must not depend on builder: {relative}')


def check_build_wiring(mobile=MOBILE):
    rn = mobile / 'react-native'
    require('integrations/appBuilder' not in (rn / 'App.tsx').read_text(), 'Standalone RN entry must not import Studio')
    require("import App from './App'" in (rn / 'index.ts').read_text(), 'Standalone RN entry changed')
    require('StudioApp' in (rn / 'index.studio.ts').read_text(), 'Studio must have a separate RN entry')
    require("studio ? 'src/studio/java' : 'src/standalone/java'" in (rn / 'android/app/build.gradle').read_text(), 'RN Android bootstrap must be build selected')
    require((rn / 'ios/Integrations/AppBuilder/StudioBootstrap.swift').read_text().startswith('#if ROCENTO_STUDIO'), 'RN iOS bootstrap must compile out of standalone')
    # Compare every checked-in target and scheme against the build-time selections.
    subprocess.run([sys.executable, str(mobile / 'tools/generate_xcode_project.py'), '--check'], check=True)
    selection = 'providers.gradleProperty("appBuilder").orNull == "true"'
    settings = (mobile / 'android/settings.gradle.kts').read_text()
    app = (mobile / 'android/app/build.gradle.kts').read_text()
    require(f'if ({selection}) include(":app-builder")' in settings,
            'The builder module must be an explicit Gradle opt-in')
    require(f'val appBuilder = {selection}' in app, 'App and settings must use the same builder opt-in')
    # All builder references in the current manifests must retain their conditional
    # wiring. Update this guard alongside any intentional restructuring.
    expected = {
        'if (appBuilder) implementation(project(":app-builder"))',
        'sourceSets["main"].kotlin.directories.add(if (appBuilder) "src/appBuilder/java" else "src/standalone/java")',
        'if (appBuilder) sourceSets["androidTest"].kotlin.directories.add("src/appBuilderAndroidTest/java")',
    }
    references = {line.strip() for line in app.splitlines()
                  if 'app-builder' in line or 'src/appBuilder' in line}
    require(references == expected, 'Builder dependency and source sets must remain conditional')
    references = [line.strip() for line in settings.splitlines() if ':app-builder' in line]
    require(references == [f'if ({selection}) include(":app-builder")'], 'Unconditional builder module inclusion')


def check_android(path):
    with zipfile.ZipFile(path) as apk:
        names = [name for name in apk.namelist() if name.endswith('.dex')]
        require(names, f'No executable DEX found in {path}')
        for name in names + [name for name in apk.namelist() if name.endswith('.so')]:
            data = apk.read(name)
            for marker in [b'com/rocento/mobile/builder/', b'v1/mobile/']:
                require(marker not in data, f'Builder code found in standalone APK {name}: {marker!r}')


def check_ios(path, published=False):
    import plistlib
    info = plistlib.loads((path / 'Info.plist').read_bytes())
    executable = path / info['CFBundleExecutable']
    require(executable.is_file(), f'No executable in {path}')
    # Embedded frameworks use extensionless Mach-O binaries, unlike debug dylibs.
    magic = {bytes.fromhex(value) for value in ('feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca')}
    binaries = {executable, *path.rglob('*.dylib')}
    for candidate in path.rglob('*'):
        if candidate.is_file():
            with candidate.open('rb') as file:
                if file.read(4) in magic:
                    binaries.add(candidate)
    for binary in binaries:
        data = binary.read_bytes()
        markers = ([b'DraftPreviewRuntime', b'HTTPDraftPreviewTransport', b'v1/mobile/preview/',
                    b'preview-session-start', b'ROCENTO_PREVIEW_CODE'] if published
                   else [b'RocentoAppBuilder', b'v1/mobile/'])
        for marker in markers:
            require(marker not in data, f'Forbidden code in iOS binary {binary.name}: {marker!r}' if published
                    else f'Builder code found in standalone iOS binary {binary.name}: {marker!r}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--android-apk', type=Path)
    parser.add_argument('--ios-app', type=Path, help='Standalone local fixture app')
    parser.add_argument('--ios-published-app', type=Path, help='Merchant Release app; rejects draft preview code')
    args = parser.parse_args()
    check_editor_dependencies()
    check_sources()
    check_build_wiring()
    if args.android_apk:
        check_android(args.android_apk)
    if args.ios_app:
        check_ios(args.ios_app)
    if args.ios_published_app:
        check_ios(args.ios_published_app, published=True)
    print('Builder isolation checks passed')
