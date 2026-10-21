"""Negative tests for the architecture gate, including real Cargo alias resolution."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from scripts.check_rust_architecture import violations


def package(name, dependencies=()):
    return {'name': name, 'id': name, 'manifest_path': f'/fixture/{name}/Cargo.toml',
            'dependencies': list(dependencies)}


def edge(name, **extra):
    return {'name': name, 'path': f'/fixture/{name}', **extra}


class RustArchitectureTests(unittest.TestCase):
    def setUp(self):
        self.metadata = {'workspace_members': ['api-gateway', 'domain-orders', 'infra-events', 'shared-kernel'],
                         'packages': [package('api-gateway', [edge('domain-orders')]),
                                      package('domain-orders', [edge('infra-events')]),
                                      package('infra-events'), package('shared-kernel')]}
        self.policy = {'version': 1, 'crates': {
            'api-gateway': {'layer': 'composition', 'allowed_internal': ['domain-orders']},
            'domain-orders': {'layer': 'domain', 'allowed_internal': ['infra-events']},
            'infra-events': {'layer': 'infrastructure', 'allowed_internal': []},
            'shared-kernel': {'layer': 'contracts', 'allowed_internal': []}}}

    def test_existing_explicit_transaction_dependency_is_allowed(self):
        self.assertEqual(violations(self.metadata, self.policy), [])

    def test_reverse_dependency_cannot_be_whitelisted(self):
        self.metadata['packages'][2]['dependencies'].append(edge('domain-orders'))
        self.policy['crates']['infra-events']['allowed_internal'].append('domain-orders')
        errors = '\n'.join(violations(self.metadata, self.policy))
        self.assertIn('lower layers', errors)
        self.assertIn('dependency cycle', errors)

    def test_new_crate_requires_classification(self):
        self.metadata['workspace_members'].append('domain-new')
        self.metadata['packages'].append(package('domain-new'))
        self.assertIn('membership differ', '\n'.join(violations(self.metadata, self.policy)))

    def test_unknown_local_dependency_and_spoofed_path_are_rejected(self):
        for dependency in [edge('unclassified'), edge('infra-events', path='/elsewhere')]:
            with self.subTest(dependency=dependency):
                metadata = copy.deepcopy(self.metadata)
                metadata['packages'][1]['dependencies'].append(dependency)
                self.assertIn('classified workspace member', '\n'.join(violations(metadata, self.policy)))

    def test_transport_and_contract_runtime_dependencies_are_rejected(self):
        for index, name in [(1, 'reqwest'), (1, 'axum'), (3, 'sqlx'), (3, 'tokio')]:
            with self.subTest(name=name):
                metadata = copy.deepcopy(self.metadata)
                metadata['packages'][index]['dependencies'].append({'name': name})
                self.assertTrue(violations(metadata, self.policy))

    def test_dev_build_optional_target_and_renamed_edges_are_checked(self):
        for kind in [None, 'dev', 'build']:
            metadata = copy.deepcopy(self.metadata)
            metadata['packages'][1]['dependencies'].append(edge('api-gateway', kind=kind,
                optional=True, rename='harmless', target='cfg(windows)'))
            self.assertIn('prohibited dependency', '\n'.join(violations(metadata, self.policy)))

    def test_stale_allowance_is_rejected(self):
        self.policy['crates']['api-gateway']['allowed_internal'].append('infra-events')
        self.assertIn('stale allowance', '\n'.join(violations(self.metadata, self.policy)))

    def test_cargo_metadata_resolves_inherited_renamed_foreign_target_edge(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'Cargo.toml').write_text('''[workspace]
members = ["api-gateway", "domain-orders"]
resolver = "2"
[workspace.dependencies]
innocent = { package = "api-gateway", path = "api-gateway" }
''')
            for name in ['api-gateway', 'domain-orders']:
                (root / name / 'src').mkdir(parents=True)
                (root / name / 'src/lib.rs').write_text('')
                dependencies = '\n[target.\'cfg(windows)\'.build-dependencies]\ninnocent.workspace = true\n' if name == 'domain-orders' else ''
                (root / name / 'Cargo.toml').write_text(f'[package]\nname = "{name}"\nversion = "0.1.0"\nedition = "2021"\n' + dependencies)
            result = subprocess.run(['cargo', 'metadata', '--offline', '--no-deps', '--format-version', '1',
                '--manifest-path', str(root / 'Cargo.toml')], check=True, capture_output=True, text=True)
            policy = {'version': 1, 'crates': {name: {'layer': layer, 'allowed_internal': []}
                for name, layer in [('api-gateway', 'composition'), ('domain-orders', 'domain')]}}
            errors = '\n'.join(violations(json.loads(result.stdout), policy))
            self.assertIn('domain-orders -> api-gateway (build, cfg(windows)): prohibited dependency', errors)
            policy_path = root / 'policy.json'
            policy_path.write_text(json.dumps(policy))
            command = Path(__file__).resolve().parents[1] / 'check-rust-architecture.py'
            rejected = subprocess.run([sys.executable, str(command), '--manifest-path',
                str(root / 'Cargo.toml'), '--policy', str(policy_path)], capture_output=True, text=True)
            self.assertEqual(rejected.returncode, 1)
            self.assertIn('prohibited dependency', rejected.stdout)


if __name__ == '__main__':
    unittest.main()
