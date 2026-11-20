import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch, Mock
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'commerce-ops/cloud/host'))
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'commerce-ops/cloud/controller'))
import fleet_release as release
import fleet_bootstrap as bootstrap
import merchant_fleet as fleet


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.pin = dict(repository='rocento/commerce-onboarding', assetId=123,
                        sha256=hashlib.sha256(b'bundle').hexdigest(), revision='a'*40,
                        inventoryDigest='sha256:'+'b'*64)

    def test_pin_requires_immutable_identifiers(self):
        release.validate(self.pin)
        for key, value in [('assetId', True), ('sha256', 'latest'), ('revision', 'main'),
                           ('repository', 'evil.invalid/repo?token=secret'), ('inventoryDigest', 'latest')]:
            with self.assertRaises(ValueError): release.validate(dict(self.pin, **{key: value}))

    def test_redirect_drops_github_token_and_rejects_untrusted_destinations(self):
        request = urllib.request.Request('https://api.github.com/repos/a/b/releases/assets/1', headers={'Authorization': 'Bearer fixture'})
        result = release.AssetRedirect().redirect_request(request, None, 302, '', {}, 'https://release-assets.githubusercontent.com/asset')
        self.assertIsNone(result.get_header('Authorization'))
        for url in ('http://release-assets.githubusercontent.com/asset', 'https://evil.invalid/asset'):
            with self.assertRaises(ValueError): release.AssetRedirect().redirect_request(request, None, 302, '', {}, url)

    def test_download_checks_digest_before_cache_and_never_reuses_tampered_cache(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            opener = Mock()
            opener.open.return_value = io.BytesIO(b'wrong bytes')
            with patch.object(release.urllib.request, 'build_opener', return_value=opener):
                with self.assertRaisesRegex(ValueError, 'BUNDLE_CHANGED'): release.download(self.pin, root, 'fixture')
            self.assertEqual(list(root.iterdir()), [])
            opener.open.return_value = io.BytesIO(b'bundle')
            with patch.object(release.urllib.request, 'build_opener', return_value=opener):
                path = release.download(self.pin, root, 'fixture')
            self.assertEqual(path.read_bytes(), b'bundle')
            path.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'CACHE_CHANGED'): release.download(self.pin, root, 'fixture')

    def test_archive_refuses_traversal_links_devices_and_duplicates(self):
        for name, kind in [('../escape', tarfile.REGTYPE), ('/escape', tarfile.REGTYPE),
                           ('link', tarfile.SYMTYPE), ('device', tarfile.CHRTYPE)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                archive = root / 'bundle.tar'
                with tarfile.open(archive, 'w') as tar:
                    info = tarfile.TarInfo(name); info.type = kind; tar.addfile(info)
                with self.assertRaisesRegex(ValueError, 'UNSAFE'): bootstrap.extract(archive, root / 'out')

    def test_cloud_init_fits_ec2_and_contains_no_github_token(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'ssh_host_ed25519_key').write_text('fixture-host-private')
            (root / 'ssh_host_ed25519_key.pub').write_text('ssh-ed25519 AAAA fixture')
            (root / 'controller.pub').write_text('ssh-ed25519 AAAA fixture')
            tools = root / 'tools'; tools.mkdir()
            (tools / 'fleet-bootstrap.py').write_bytes((ROOT / 'commerce-ops/cloud/host/fleet_bootstrap.py').read_bytes())
            assets = tools / 'fleet-bootstrap-assets'; assets.mkdir()
            for name in ('metadata-firewall.nft', 'metadata-firewall.service'):
                (assets / name).write_bytes((ROOT / 'commerce-ops/services/onboarding' / name).read_bytes())
            profile = dict(release=self.pin, environment='aws-test', minMemoryGiB=16)
            cfg = dict(providers={'aws': profile}, sshPublicKey=str(root / 'controller.pub'), sshPrivateKey='/fixture/key', githubTokenFile='/private/github.token')
            host = dict(id='11111111-1111-1111-1111-111111111111', provider='aws', release_digest=self.pin['inventoryDigest'])
            with patch.object(fleet, 'host_directory', return_value=root), patch.object(fleet, 'trusted', side_effect=Path), patch.object(fleet, 'secret', side_effect=lambda p: Path(p).read_text()), patch.object(fleet, 'run', return_value=b'ssh-ed25519 AAAA'), patch.object(fleet, 'TOOLS', tools):
                payload = fleet.cloud_init(host, cfg)
            self.assertLess(len(payload.encode()), 16384)
            self.assertNotIn('github.token', payload)
            body = json.loads(payload.split('\n', 1)[1])
            docker_config = next(item for item in body['write_files'] if item['path'] == '/etc/docker/daemon.json')
            self.assertFalse(json.loads(docker_config['content'])['features']['containerd-snapshotter'])
            self.assertEqual(json.loads(docker_config['content'])['log-driver'], 'json-file')
            self.assertEqual(json.loads(docker_config['content'])['log-opts'], {'max-size': '20m', 'max-file': '5'})
            script = body['runcmd'][0][-1]
            self.assertLess(script.index('enable --now rocento-metadata-firewall'), script.index('install -y docker'))
            self.assertIn('fleet-bootstrap.py', body['users'][0]['ssh_authorized_keys'][0])

    def test_public_artifacts_readable_without_exposing_release_evidence(self):
        with tempfile.TemporaryDirectory() as temp:
            parent = Path(temp) / 'releases'; parent.mkdir(mode=0o700)
            root = parent / 'candidate'; root.mkdir(mode=0o700)
            asset = root / 'artifacts/storefront/index.html'
            asset.parent.mkdir(parents=True)
            asset.write_text('public storefront')
            private = root / 'evidence/config.json'
            private.parent.mkdir()
            private.write_text('private evidence')
            bootstrap.release_permissions(root)
            for path in (parent, root, root / 'artifacts', asset.parent):
                self.assertTrue(path.stat().st_mode & 0o001)
                self.assertFalse(path.stat().st_mode & 0o022)
            self.assertEqual(asset.stat().st_mode & 0o777, 0o644)
            self.assertEqual(private.stat().st_mode & 0o777, 0o600)
            self.assertEqual(private.parent.stat().st_mode & 0o777, 0o700)
            self.assertEqual(asset.read_text(), 'public storefront')
            link = root / 'artifacts/link'; link.symlink_to(private)
            with self.assertRaisesRegex(ValueError, 'UNSAFE_RELEASE_PATH'):
                bootstrap.release_permissions(root)

    def test_transfer_is_file_backed_and_pinned_to_host(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'bundle'; path.write_bytes(b'bundle')
            def run(args, **kwargs):
                stream = kwargs['stdin']
                self.assertEqual(json.loads(stream.readline()), {'operation': 'install-release', 'hostId': 'fixture'})
                self.assertEqual(stream.read(), b'bundle')
                return Mock(returncode=0, stdout=b'{"installed": true}')
            with patch.object(release.subprocess, 'run', side_effect=run): release.transfer(['ssh', 'fixture'], path, 'fixture')

    def test_install_verification_failure_preserves_intent_and_never_marks_ready(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            packages = root / 'packages'; packages.touch()
            inventory = json.dumps({'source': {'revision': self.pin['revision']}, 'version': 'fixture'}).encode()
            data = io.BytesIO()
            with tarfile.open(fileobj=data, mode='w:gz') as archive:
                for name, content in [('release/inventory.json', inventory), ('images.tar', b'')]:
                    info = tarfile.TarInfo(name); info.size = len(content)
                    archive.addfile(info, io.BytesIO(content))
            raw = data.getvalue()
            config = dict(release=dict(self.pin, sha256=hashlib.sha256(raw).hexdigest()),
                          releaseDigest='sha256:'+hashlib.sha256(inventory).hexdigest())
            merchant = Mock()
            merchant.authorized_release.side_effect = ValueError('RELEASE_REVIEW_REQUIRED')
            spec = Mock()
            with patch.object(bootstrap, 'ROOT', root / 'bootstrap'), patch.object(bootstrap, 'PACKAGES_READY', packages), patch.object(bootstrap, 'RELEASES', root / 'releases'), patch.object(bootstrap.subprocess, 'run'), patch.object(bootstrap.importlib.util, 'spec_from_file_location', return_value=spec), patch.object(bootstrap.importlib.util, 'module_from_spec', return_value=merchant):
                with self.assertRaisesRegex(ValueError, 'REVIEW_REQUIRED'): bootstrap.install(config, io.BytesIO(raw))
                self.assertTrue((root / 'bootstrap/install-intent').exists())
                self.assertFalse((root / 'bootstrap/ready').exists())
                with self.assertRaisesRegex(ValueError, 'RECONCILIATION_REQUIRED'): bootstrap.install(config, io.BytesIO(raw))

    def test_bundle_pin_changes_host_compatibility(self):
        profile = {'release': self.pin, 'maxHosts': 2}
        self.assertNotEqual(fleet.profile_digest(profile), fleet.profile_digest(dict(profile, release=dict(self.pin, assetId=456))))


if __name__ == '__main__': unittest.main()
