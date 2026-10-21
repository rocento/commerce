"""Image identity checks and container gate isolation."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import commerce_image as image
import commerce_release as release


class ImageTests(unittest.TestCase):
    def test_remote_docker_is_rejected(self):
        with patch.object(image.baseline, 'command', return_value=b'ssh://remote'):
            with self.assertRaisesRegex(RuntimeError, 'local Unix-socket'):
                image.require_local_docker()

    def test_image_manifest_binds_source_identity_user_and_binaries(self):
        for mutation in (None, 'identity', 'source', 'user', 'binary'):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = {'files': {'Dockerfile': 'source-file-hash'}}
                source['sha256'] = hashlib.sha256(json.dumps(source['files'], sort_keys=True).encode()).hexdigest()
                hashes = {n: 'hash-' + n for n in image.BINARIES}
                identity = 'sha256:' + 'a' * 64
                manifest = {'schema_version': 1, 'profile': 'release', 'image_id': identity,
                            'source_sha256': source['sha256'], 'os': 'linux', 'architecture': 'arm64',
                            'user': '10001:10001', 'binaries': hashes}
                info = {'Id': identity, 'Os': 'linux', 'Architecture': 'arm64',
                        'Config': {'User': '10001:10001', 'Labels': {'io.rocento.source.sha256': source['sha256']}}}
                if mutation == 'identity':
                    manifest['image_id'] = 'mutable:latest'
                elif mutation == 'source':
                    source['files']['Dockerfile'] = 'changed'
                elif mutation == 'user':
                    info['Config']['User'] = 'root'
                elif mutation == 'binary':
                    manifest['binaries'] = dict(hashes, **{'api-gateway': 'different'})
                (root / 'release-image.json').write_text(json.dumps(manifest))
                (root / 'image-source-manifest.json').write_text(json.dumps(source))
                with patch.object(image, 'require_local_docker'), patch.object(image, 'inspect_image', return_value=info), patch.object(image, 'binary_hashes', return_value=hashes):
                    if mutation:
                        with self.assertRaises(RuntimeError):
                            image.load_image(root)
                    else:
                        self.assertEqual(image.load_image(root), manifest)

    def test_container_uses_private_provider_addresses_not_host_environment(self):
        stack = object.__new__(image.ImageStack)
        stack.config = {'services': {'api-gateway': {'environment': {
            'DATABASE_URL': 'postgres://synthetic@postgres/commerce', 'NATS_URL': 'nats://nats:4222',
            'ASSISTANT_TENANT_ID': 'must-be-removed'}}}}
        stack.env = {k: 'synthetic' for k in ('APP_ENV', 'NOTIFICATION_MODE', 'COOKIE_SECURE',
            'RESERVATION_TTL_SECONDS', 'REPORTING_INTERVAL_SECONDS', 'DB_MAX_CONNECTIONS')}
        stack.env.update(DATABASE_URL='host-only-address', AWS_SECRET_ACCESS_KEY='must-not-be-inherited',
                         NOTIFICATION_MODE='mailpit', MAILPIT_URL='http://127.0.0.1:1')
        environment = stack.container_environment()
        self.assertEqual(environment['DATABASE_URL'], 'postgres://synthetic@postgres/commerce')
        self.assertEqual(environment['BIND_ADDRESS'], '0.0.0.0:8080')
        self.assertEqual(environment['NOTIFICATION_MODE'], 'mailpit')
        self.assertEqual(environment['MAILPIT_URL'], 'http://127.0.0.1:1')
        self.assertNotIn('AWS_SECRET_ACCESS_KEY', environment)
        self.assertNotIn('ASSISTANT_TENANT_ID', environment)

    def test_cli_image_gate_requires_fault_scenarios_and_release_profile(self):
        with patch.object(release.baseline, 'main', return_value=1) as run:
            self.assertEqual(release.main(['verify-image', '--candidate', '/tmp/candidate']), 1)
        args = run.call_args.args[0]
        self.assertEqual(args[:2], ['--profile', 'release'])
        self.assertIn('--analytics-faults', args)
        self.assertIn('--async-faults', args)


if __name__ == '__main__':
    unittest.main()
