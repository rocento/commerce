import copy
import hashlib
import importlib.util
import json
import io
import shutil
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[3]


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'commerce-ops/services/onboarding' / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


prepare = module('merchant_candidate_prepare', 'prepare-merchant-candidate.py')
verify = module('merchant_candidate_verify', 'verify-merchant-candidate.py')
executor = module('candidate_executor', '../../cloud/host/merchant_executor.py')


class MerchantCandidateSourceTests(unittest.TestCase):
    def test_real_demo_theme_dependencies_are_complete_and_safe(self):
        counts = {'grocery': 0, 'jewelry': 3, 'electronics': 3, 'pharmacy': 2}
        for theme, count in counts.items():
            dependencies = prepare.theme_dependencies(ROOT, theme)
            self.assertEqual(len(dependencies['assets']), count)
            for asset in dependencies['assets']:
                self.assertLessEqual((ROOT / 'commerce-assets/demo' / asset).stat().st_size, 5 * 1024 * 1024)
            if count:
                self.assertTrue(dependencies['categories'])

    def test_theme_assets_cannot_escape_demo_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            directory = source / 'commerce-demo/jewelry'
            directory.mkdir(parents=True)
            for reference in ('asset:../../secret.png', 'asset:pharmacy/hero.png'):
                (directory / 'theme.json').write_text(json.dumps({'image': reference}))
                with self.assertRaisesRegex(ValueError, 'Unsafe'):
                    prepare.theme_dependencies(source, 'jewelry')

    def test_hashes_dirty_sources_and_excludes_private_generated_files(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp)
            (source / 'api/target').mkdir(parents=True)
            (source / 'api/main.rs').write_text('version one')
            (source / 'api/.env').write_text('private fixture')
            (source / 'api/target/generated').write_text('generated')
            files = prepare.source_files(source, ('api',))
            self.assertEqual(set(files), {'api/main.rs'})
            (source / 'api/main.rs').write_text('version two')
            self.assertNotEqual(files, prepare.source_files(source, ('api',)))

    def test_symlinks_cannot_escape_source_boundary(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp)
            (source / 'input').mkdir()
            (source / 'outside').write_text('fixture')
            (source / 'input/link').symlink_to(source / 'outside')
            with self.assertRaisesRegex(ValueError, 'non-symlink'):
                prepare.source_files(source, ('input',))

    def test_prebuild_manifest_cannot_be_replaced_by_current_source(self):
        with patch.object(prepare, 'source_manifest', return_value={'revision': 'a' * 40, 'changed': True}):
            with self.assertRaisesRegex(ValueError, 'pre-build'):
                prepare.verify_source_manifest(Path('/unused'), {'revision': 'a' * 40})

    def test_missing_or_wrong_image_labels_fail(self):
        manifest = {'components': {name: {'sha256': name + '-fingerprint'} for name in ('api', 'minio', 'web')}}
        images = {name: {'Config': {'Labels': {'io.rocento.source.sha256': name + '-fingerprint'}}}
                  for name in ('api', 'minio', 'web')}
        prepare.verify_image_provenance(images, images['web'], manifest)
        for bad in (None, {}, {'io.rocento.source.sha256': 'other-source'}):
            altered = copy.deepcopy(images)
            altered['api']['Config']['Labels'] = bad
            with self.assertRaisesRegex(ValueError, 'api'):
                prepare.verify_image_provenance(altered, images['web'], manifest)

    def local_draft_matches_installed(self, minio_override=None, image_ids=None, wrong_identity=None):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'
            tools = root / 'installed-tools'
            tools.mkdir()
            for name in prepare.THEMES:
                theme = source / 'commerce-demo' / name / 'theme.json'
                theme.parent.mkdir(parents=True)
                theme.write_text(json.dumps({'fixtureTheme': name}))
            for key in ('executor', 'templates', 'policy'):
                path = source / prepare.TOOL_SOURCES[key]
                path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / prepare.TOOL_SOURCES[key], path)
                shutil.copyfile(path, tools / {'executor': 'merchant-executor.py', 'templates': 'merchant_templates.py', 'policy': 'release_readiness.py'}[key])
            manifest = {'components': {key: {'sha256': 'b' * 64} for key in ('api', 'web', 'minio')},
                        'tools': {key: prepare.digest(source / prepare.TOOL_SOURCES[key]) for key in ('executor', 'templates', 'policy')}}
            manifest['components']['api']['files'] = {'commerce-api/rocento-api/migrations/1.sql': 'c' * 64}
            input_path = root / 'source.json'
            input_path.write_text(json.dumps(manifest))
            image_tags = [*prepare.IMAGES.values(), prepare.WEB_IMAGE]
            inspected = []
            if minio_override:
                image_tags.append(minio_override)
            if image_ids:
                image_tags.extend(image_ids.values())

            def docker(args):
                if args[:3] == ['docker', 'image', 'inspect']:
                    self.assertIn(args[3], image_tags)
                    inspected.append(args[3])
                    identity = args[3] if args[3].startswith('sha256:') else 'sha256:' + hashlib.sha256(args[3].encode()).hexdigest()
                    if args[3] == wrong_identity:
                        identity = 'sha256:' + 'f' * 64
                    return json.dumps([{'Id': identity,
                        'Architecture': 'arm64', 'Os': 'linux', 'RepoDigests': [],
                        'Config': {'Labels': {'io.rocento.source.sha256': 'b' * 64}}}]).encode()
                if args[:2] == ['docker', 'create']:
                    self.assertTrue(args[2].startswith('sha256:'))
                    return b'disposable-artifact-extraction'
                if args[:2] == ['docker', 'cp']:
                    destination = Path(args[3])
                    destination.mkdir()
                    (destination / 'index.html').write_text('<html>fixture</html>')
                    return b''
                self.assertEqual(args, ['docker', 'rm', 'disposable-artifact-extraction'])
                return b''

            host_config = root / 'host-configuration'
            arguments = ['--source', str(source), '--source-manifest', str(input_path),
                         '--environment', 'aws-merchant-production', '--release-version', 'grocery-production-v1']
            if minio_override:
                arguments += ['--minio-image-id', minio_override]
            if image_ids:
                ids_path = root / 'image-ids.json'
                ids_path.write_text(json.dumps(image_ids))
                arguments += ['--image-ids', str(ids_path)]
            with patch.object(prepare, 'CONFIG', host_config), patch.object(prepare, 'TOOLS', tools), \
                 patch.object(prepare, 'verify_source_manifest'), patch.object(prepare, 'run', side_effect=docker), \
                 patch('sys.stdout', io.StringIO()):
                with patch.object(prepare.os, 'geteuid', return_value=501):
                    prepare.main(arguments + ['--output-directory', str(root / 'local-draft')])
                    self.assertFalse(host_config.exists())
                with patch.object(prepare.os, 'geteuid', return_value=0):
                    prepare.main(arguments)
            installed = next((host_config / 'releases').iterdir())
            self.assertEqual((root / 'local-draft/inventory.json').read_bytes(), (installed / 'inventory.json').read_bytes())
            packet = json.loads((root / 'local-draft/readiness.json').read_text())
            inventory = json.loads((root / 'local-draft/inventory.json').read_text())
            self.assertEqual(packet['environment'], 'aws-merchant-production')
            self.assertEqual(inventory['configuration']['environment'], packet['environment'])
            self.assertEqual(inventory['version'], 'grocery-production-v1')
            self.assertEqual(inventory['themes'], list(prepare.THEMES))
            for name in prepare.THEMES:
                self.assertIn('themes/' + name + '.json', inventory['files'])
                self.assertEqual(json.loads((root / 'local-draft/artifacts/themes' / (name + '.json')).read_text()), {'fixtureTheme': name})
            self.assertIsNone(packet['approval'])
            self.assertTrue(all(check['status'] == 'pending' for check in packet['checks']))
            if image_ids:
                self.assertEqual(set(inspected), set(image_ids.values()))
                self.assertTrue(all(inspected.count(identity) == 2 for identity in image_ids.values()))
                inventory = json.loads((root / 'local-draft/inventory.json').read_text())
                self.assertEqual(inventory['images'], {key: image_ids[key] for key in prepare.IMAGES})
                self.assertEqual(inventory['frontendImage'], image_ids['web'])
            elif minio_override:
                self.assertEqual(inspected.count(minio_override), 2)
                self.assertNotIn(prepare.IMAGES['minio'], inspected)
                inventory = json.loads((root / 'local-draft/inventory.json').read_text())
                self.assertEqual(inventory['images']['minio'], minio_override)
            else:
                self.assertEqual(inspected.count(prepare.IMAGES['minio']), 2)

    def test_local_draft_matches_installed_candidate_without_root_or_authorization(self):
        self.local_draft_matches_installed()

    def test_minio_override_uses_exact_id_without_retagging_or_changing_defaults(self):
        before = dict(prepare.IMAGES)
        self.local_draft_matches_installed('sha256:' + 'e' * 64)
        self.assertEqual(prepare.IMAGES, before)

    def test_minio_override_rejects_mutable_or_malformed_ids_before_docker(self):
        for identity in ('candidate:latest', 'sha256:' + 'A' * 64, 'sha256:' + 'e' * 63):
            with self.subTest(identity=identity), patch.object(prepare, 'run') as run, \
                 patch('sys.stderr', io.StringIO()), self.assertRaises(SystemExit):
                prepare.main(['--source-manifest', '/unused', '--minio-image-id', identity])
            run.assert_not_called()

    def test_all_engine_ids_are_used_without_retagging_or_changing_defaults(self):
        before = dict(prepare.IMAGES)
        identities = {key: 'sha256:' + format(index, '064x')
                      for index, key in enumerate([*prepare.IMAGES, 'web'], 1)}
        self.local_draft_matches_installed(image_ids=identities)
        self.assertEqual(prepare.IMAGES, before)

    def test_wrong_engine_identity_rejected_for_api_and_web(self):
        identities = {key: 'sha256:' + format(index, '064x')
                      for index, key in enumerate([*prepare.IMAGES, 'web'], 1)}
        for role in ('api', 'web'):
            with self.subTest(role=role), self.assertRaisesRegex(SystemExit, 'identity does not match'):
                self.local_draft_matches_installed(image_ids=identities, wrong_identity=identities[role])

    def test_engine_ids_require_exact_roles_and_immutable_unique_json(self):
        valid = {key: 'sha256:' + format(index, '064x')
                 for index, key in enumerate([*prepare.IMAGES, 'web'], 1)}
        bad = [[], {}, {key: value for key, value in valid.items() if key != 'web'},
               dict(valid, unexpected='sha256:' + 'e' * 64), dict(valid, api='candidate:latest'),
               dict(valid, minio='sha256:' + 'A' * 64), dict(valid, postgres=42)]
        raw_inputs = [json.dumps(value) for value in bad] + [
            '{"api":"sha256:' + 'a' * 64 + '","api":"sha256:' + 'b' * 64 + '"}', '{invalid']
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'ids.json'
            for raw in raw_inputs:
                path.write_text(raw)
                with self.subTest(raw=raw), patch.object(prepare, 'run') as run, \
                     patch('sys.stderr', io.StringIO()), self.assertRaises(SystemExit):
                    prepare.main(['--source-manifest', '/unused', '--image-ids', str(path)])
                run.assert_not_called()

    def test_default_installation_remains_root_only(self):
        with patch.object(prepare.os, 'geteuid', return_value=501), patch.object(prepare, 'run') as run:
            with self.assertRaisesRegex(SystemExit, 'as root'):
                prepare.main(['--source-manifest', '/unused'])
        run.assert_not_called()


class MerchantCandidateVerificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.inventory = {
            'schemaVersion': 1, 'theme': 'grocery', 'architecture': 'arm64',
            'images': {name: 'sha256:' + format(index, '064x') for index, name in
                       enumerate(('api', 'postgres', 'nats', 'meili', 'minio', 'clickhouse'), 1)},
            'tools': {'executor': 'executor-sha', 'templates': 'templates-sha', 'policy': 'policy-sha'},
            'source': {'tools': {'verifier': 'verifier-sha'}}, 'files': {},
        }
        for name, contents in [('storefront/index.html', '<html>Storefront</html>'),
                               ('admin/index.html', '<html>Admin</html>'), ('theme.json', '{}')]:
            path = self.root / 'artifacts' / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(contents)
            self.inventory['files'][name] = hashlib.sha256(path.read_bytes()).hexdigest()
        self.candidate = 'a' * 64
        self.executor = Mock()
        self.executor.release_themes.side_effect = executor.release_themes
        self.executor.required_artifacts.side_effect = executor.required_artifacts
        self.executor.read_json.return_value = self.inventory
        self.executor.sha.side_effect = self.sha
        self.executor.command.side_effect = self.inspect
        self.architecture = patch.object(verify.os, 'uname', return_value=SimpleNamespace(machine='aarch64'))
        self.architecture.start()
        self.addCleanup(self.architecture.stop)

    def sha(self, path):
        values = {self.root / 'inventory.json': self.candidate, verify.EXECUTOR: 'executor-sha',
                  verify.POLICY: 'policy-sha', verify.TEMPLATES: 'templates-sha', Path(verify.__file__): 'verifier-sha'}
        return values[path] if path in values else hashlib.sha256(path.read_bytes()).hexdigest()

    def inspect(self, args):
        self.assertEqual(args[:3], ['docker', 'image', 'inspect'])
        return json.dumps([{'Id': args[3], 'Architecture': 'arm64', 'Os': 'linux'}]).encode()

    def test_exact_ids_and_artifacts_verified_without_approval(self):
        self.assertEqual(verify.candidate_inventory(self.executor, self.root, self.candidate), self.inventory)
        self.assertEqual(self.executor.command.call_count, 6)
        self.assertTrue(all(call.args[0][-1].startswith('sha256:') for call in self.executor.command.call_args_list))
        self.executor.compose.assert_not_called()

    def test_four_theme_bundle_requires_every_inventoried_configuration(self):
        self.inventory['schemaVersion'] = 2
        self.inventory['themes'] = list(prepare.THEMES)
        del self.inventory['theme']
        del self.inventory['files']['theme.json']
        (self.root / 'artifacts/theme.json').unlink()
        for theme in prepare.THEMES:
            name = 'themes/' + theme + '.json'
            path = self.root / 'artifacts' / name
            path.parent.mkdir(exist_ok=True)
            path.write_text(json.dumps({'theme': theme}))
            self.inventory['files'][name] = hashlib.sha256(path.read_bytes()).hexdigest()
        verify.candidate_inventory(self.executor, self.root, self.candidate)
        (self.root / 'artifacts/themes/jewelry.json').unlink()
        with self.assertRaisesRegex(ValueError, 'CANDIDATE_ARTIFACT_SET_CHANGED'):
            verify.candidate_inventory(self.executor, self.root, self.candidate)

    def test_runtime_qualification_covers_every_bundled_theme(self):
        inventory = dict(self.inventory, schemaVersion=2, themes=list(prepare.THEMES))
        self.executor.CONFIG = self.root / 'config'
        with patch.object(verify.os, 'geteuid', return_value=0), patch.object(verify, 'load_executor', return_value=self.executor), patch.object(verify, 'candidate_inventory', return_value=inventory), patch.object(verify, 'verify_theme') as run:
            verify.main(['--disposable', '--candidate-sha256', self.candidate])
        self.assertEqual([call.args[-1] for call in run.call_args_list], list(prepare.THEMES))

    def test_template_drift_or_missing_pin_blocks_before_docker(self):
        for checksum in ('changed', None):
            with self.subTest(checksum=checksum):
                if checksum is None:
                    self.inventory['tools'].pop('templates', None)
                else:
                    self.inventory['tools']['templates'] = checksum
                with self.assertRaises((ValueError, KeyError)):
                    verify.candidate_inventory(self.executor, self.root, self.candidate)
                self.executor.command.assert_not_called()

    def test_stale_inventory_rejected_before_docker(self):
        with self.assertRaisesRegex(ValueError, 'INVENTORY_CHANGED'):
            verify.candidate_inventory(self.executor, self.root, 'b' * 64)
        self.executor.command.assert_not_called()

    def test_executor_or_verifier_drift_rejected_before_docker(self):
        self.inventory['tools']['executor'] = 'changed'
        with self.assertRaisesRegex(ValueError, 'TOOL_CHANGED'):
            verify.candidate_inventory(self.executor, self.root, self.candidate)
        self.executor.command.assert_not_called()
        self.inventory['tools']['executor'] = 'executor-sha'
        self.inventory['source']['tools']['verifier'] = 'changed'
        with self.assertRaisesRegex(ValueError, 'VERIFIER_CHANGED'):
            verify.candidate_inventory(self.executor, self.root, self.candidate)
        self.executor.command.assert_not_called()

    def test_mutable_tag_and_wrong_architecture_fail(self):
        self.inventory['images']['api'] = 'candidate:latest'
        with self.assertRaisesRegex(ValueError, 'NOT_PINNED'):
            verify.candidate_inventory(self.executor, self.root, self.candidate)
        self.executor.command.assert_not_called()
        self.inventory['architecture'] = 'amd64'
        with self.assertRaisesRegex(ValueError, 'ARCHITECTURE_MISMATCH'):
            verify.candidate_inventory(self.executor, self.root, self.candidate)

    def test_artifact_tampering_and_extra_files_fail(self):
        (self.root / 'artifacts/theme.json').write_text('{"changed":true}')
        with self.assertRaisesRegex(ValueError, 'ARTIFACT_CHANGED'):
            verify.candidate_inventory(self.executor, self.root, self.candidate)
        (self.root / 'artifacts/extra.js').write_text('extra')
        with self.assertRaisesRegex(ValueError, 'ARTIFACT_SET_CHANGED'):
            verify.candidate_inventory(self.executor, self.root, self.candidate)
        self.executor.compose.assert_not_called()

    def test_missing_candidate_argument_is_rejected_before_loading_executor(self):
        with patch.object(verify, 'load_executor') as load, patch('sys.stderr', io.StringIO()), self.assertRaises(SystemExit):
            verify.main(['--disposable'])
        load.assert_not_called()

    def test_directory_symlink_cannot_add_uninventoried_content(self):
        (self.root / 'external').mkdir()
        (self.root / 'artifacts/extra').symlink_to(self.root / 'external', target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'ARTIFACT_SYMLINK'):
            verify.candidate_inventory(self.executor, self.root, self.candidate)
        self.executor.compose.assert_not_called()

    def test_log_failure_still_cleans_only_the_fresh_fixture(self):
        fixture_root = self.root / 'runs'
        self.executor.CONFIG = self.root / 'config'
        self.executor.render_compose.return_value = {'name': 'disposable-test'}
        with patch.object(verify, 'ROOT', fixture_root), patch.object(verify.os, 'geteuid', return_value=0), \
             patch.object(verify, 'load_executor', return_value=self.executor), \
             patch.object(verify, 'candidate_inventory', return_value=self.inventory), \
             patch.object(verify.subprocess, 'run', side_effect=OSError('log collector unavailable')), \
             patch('sys.stdout', io.StringIO()):
            verify.main(['--disposable', '--candidate-sha256', self.candidate])
        fixture = next(fixture_root.iterdir())
        self.executor.compose.assert_any_call(fixture, 'down', '-v')
        report = json.loads((fixture / 'runtime-evidence.json').read_text())
        self.assertEqual(report['cleanup'], 'passed')
        self.assertEqual(report['logCollection'], 'failed')
        self.assertEqual(report['candidate_sha256'], self.candidate)
        self.assertEqual(self.executor.bootstrap.call_args.args[-1], self.root / 'config/releases' / self.candidate)
        self.assertNotEqual(report['fixture'], '00000000-0000-4000-8000-000000000111')


if __name__ == '__main__':
    unittest.main()
