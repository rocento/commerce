"""Exercise installed merchant dependencies outside the checkout without host IO."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
ASSETS = ROOT / 'commerce-ops/services/onboarding'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


package = load('merchant_package', ASSETS / 'package-merchant-release.py')
prepare = load('merchant_prepare', ASSETS / 'prepare-merchant-candidate.py')
INSTALL = re.compile(r'^install -m ([0-7]+) "\$root/([^"]+)" (/\S+)$', re.MULTILINE)


class MerchantPackagingTests(unittest.TestCase):
    def install_fixture(self, installer, directory):
        """Materialize the installer's explicit Python mappings, preserving modes."""
        mappings = INSTALL.findall((ASSETS / installer).read_text())
        self.assertTrue(mappings)
        known = json.loads((ROOT / 'commerce-ops/config/entrypoints.json').read_text())
        for mode, source, destination in mappings:
            if not source.endswith('.py'):
                continue
            self.assertIn(source, known['commands'])
            self.assertEqual(Path(destination).parent, Path('/usr/local/lib/rocento'))
            target = directory / Path(destination).name
            shutil.copyfile(ROOT / source, target)
            target.chmod(int(mode, 8))

    def isolated(self, directory, code, *, check=True):
        # -I removes checkout/PYTHONPATH dependencies; only the installed tree
        # is explicitly made importable. No script main or host command runs.
        result = subprocess.run(
            [sys.executable, '-I', '-B', '-c',
             'import sys; sys.path.insert(0, sys.argv[1]);\n' + code, str(directory)],
            cwd=directory.parent, capture_output=True, text=True, timeout=15)
        if check:
            self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def test_node_package_covers_installer_without_controller_sources(self):
        sources = set(package.SOURCES)
        self.assertEqual(len(sources), len(package.SOURCES))
        self.assertFalse(any('/controller/' in path for path in sources))
        for _, source, _ in INSTALL.findall((ASSETS / 'install-fleet-node.sh').read_text()):
            self.assertIn(source, sources)
        for key in ('executor', 'templates', 'policy'):
            self.assertIn(prepare.TOOL_SOURCES[key], sources)

    def test_installed_node_renders_and_identifies_all_runtime_dependencies(self):
        with tempfile.TemporaryDirectory() as temporary:
            installed = Path(temporary) / 'node'
            installed.mkdir()
            self.install_fixture('install-fleet-node.sh', installed)
            code = '''import hashlib, importlib.util, json
from pathlib import Path
from types import SimpleNamespace
def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(sys.argv[1]) / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
merchant = load('merchant', 'merchant-executor.py')
node = load('node', 'fleet-node.py')
load('controls', 'tenant-controls.py')
load('policy', 'release_readiness.py')
node.TOOLS = Path(sys.argv[1])
job = dict(tenantId='11111111-1111-4111-8111-111111111111',
           artifactDigest='sha256:' + 'a'*64,
           storefrontHost='test.rocento.com', adminHost='test-admin.rocento.com')
inventory = {'images': {k: 'sha256:' + 'b'*64 for k in ('api','postgres','nats','meili','minio','clickhouse')}}
compose = merchant.render_compose(job, {'gatewayPort': 18000}, inventory, Path('/release'))
assert compose['services']['api-gateway']['ports'] == ['127.0.0.1:18000:8080']
assert 'server_name test.rocento.com;' in merchant.nginx_config(job, {'gatewayPort': 18000}, Path('/release'))
reader = SimpleNamespace(sha=lambda p: hashlib.sha256(p.read_bytes()).hexdigest())
print(json.dumps(node.identity({'hostId': 'fixture'}, reader)['tools']))
'''
            identity = json.loads(self.isolated(installed, code).stdout)
            self.assertEqual(set(identity), {'node', 'executor', 'templates', 'policy', 'controls'})
            self.assertEqual(identity['templates'], hashlib.sha256((installed / 'merchant_templates.py').read_bytes()).hexdigest())
            # A missing dependency must fail in isolation, not fall back to the checkout.
            (installed / 'merchant_templates.py').unlink()
            missing = self.isolated(installed, code, check=False)
            self.assertNotEqual(missing.returncode, 0)
            self.assertIn('merchant_templates.py', missing.stderr)

    def test_installed_controller_loads_without_checkout_and_pins_node_tools(self):
        with tempfile.TemporaryDirectory() as temporary:
            installed = Path(temporary) / 'controller'
            installed.mkdir()
            self.install_fixture('install-merchant-worker.sh', installed)
            modules = ROOT / 'commerce-ops/cloud/controller/merchant-terraform'
            for provider in ('aws', 'gcp', 'hetzner'):
                target = installed / 'merchant-terraform' / provider
                target.mkdir(parents=True)
                for filename in ('main.tf.json', '.terraform.lock.hcl'):
                    shutil.copyfile(modules / provider / filename, target / filename)
            code = '''import json
from pathlib import Path
import merchant_fleet, fleet_providers, fleet_release, fleet_terraform
merchant_fleet.TOOLS = Path(sys.argv[1])
# Production trust validation requires root-owned ancestors; this test changes
# only that check, leaving real installed file hashing and module discovery.
merchant_fleet.trusted = lambda p: p
assert fleet_terraform.MODULES == Path(sys.argv[1]).resolve() / 'merchant-terraform'
assert all(len(fleet_terraform.module_digest(p)) == 64 for p in ('aws','gcp','hetzner'))
print(json.dumps(merchant_fleet.expected_tools()))
'''
            identity = json.loads(self.isolated(installed, code).stdout)
            self.assertEqual(set(identity), {'node', 'executor', 'templates', 'policy', 'controls'})


if __name__ == '__main__':
    unittest.main()
