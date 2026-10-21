"""Website-only publication must preserve other applications and roll back failures."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('website_publication', ROOT / 'commerce-ops/deploy/ec2/server/ec2-publish-website.py')
publication = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publication)


class WebsitePublicationTests(unittest.TestCase):
    def test_cli_custom_nginx_path_preserves_release_gate(self):
        (self.root / 'deploy/ec2').mkdir(parents=True)
        (self.root / 'deploy/ec2/setup.lock').touch()
        certificate = self.root / 'origin.pem'
        argv = ['publish', '--source', str(self.source), '--root', str(self.root),
                '--nginx-config', str(self.nginx), '--origin-certificate', str(certificate)]
        with patch('sys.argv', argv), patch.object(publication.os, 'geteuid', return_value=0), \
                patch.object(publication.subprocess, 'run') as gate, \
                patch.object(publication, 'origin_probe') as probe, \
                patch.object(publication, 'publish', return_value={}) as publish:
            publication.main()
        gate.assert_called_once_with(
            ['python3', str(self.root / 'commerce-ops/scripts/release/deployment_gate.py'), 'check',
             '--source', str(self.source), '--operation', 'website', '--domain', 'rocento.com'],
            check=True)
        probe.assert_called_once_with('rocento.com', certificate)
        self.assertEqual(publish.call_args.args[2], self.nginx)

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.base = self.root / 'public'
        self.previous = self.base / 'releases/release-previous'
        for site in publication.SITES:
            (self.previous / site).mkdir(parents=True)
            (self.previous / site / 'index.html').write_text(f'Previous {site}')
        (self.base / 'current').symlink_to(self.previous)
        self.source = self.root / 'export'
        for filename in publication.REQUIRED:
            target = self.source / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('New website')
        (self.source / 'docs/api/openapi.json').write_text(json.dumps({
            'openapi': '3.0.3', 'paths': {'/v1/catalog/products': {'get': {}}}}))
        self.nginx = self.root / 'nginx'
        secured = publication.policy.nginx('rocento.com')
        self.old_config = secured.replace(publication.policy.api_docs_locations(), '').replace(
            publication.policy.private_api_spec_location(), '')
        self.nginx.write_text(self.old_config)
        self.commands = []

    def publish(self, **kwargs):
        return publication.publish(self.source, self.base, self.nginx, 'rocento.com',
                                   runner=kwargs.pop('runner', self.commands.append), **kwargs)

    def test_success_replaces_only_website_and_retains_independent_rollback_files(self):
        probes = []
        result = self.publish(probe=lambda: probes.append(True))
        active = (self.base / 'current').resolve()
        self.assertEqual(str(active), result['release'])
        self.assertEqual(result['previous'], str(self.previous))
        self.assertEqual((active / 'website/index.html').read_text(), 'New website')
        self.assertEqual((self.previous / 'website/index.html').read_text(), 'Previous website')
        for site in publication.SITES[1:]:
            self.assertEqual((active / site / 'index.html').read_bytes(), (self.previous / site / 'index.html').read_bytes())
            self.assertNotEqual((active / site / 'index.html').stat().st_ino, (self.previous / site / 'index.html').stat().st_ino)
        self.assertEqual(self.commands, [['nginx', '-t'], ['systemctl', 'reload', 'nginx']])
        self.assertEqual(probes, [True])

    def test_invalid_nginx_never_activates_candidate_and_restores_config(self):
        def runner(command):
            self.commands.append(command)
            if len(self.commands) == 1:
                raise subprocess.CalledProcessError(1, command)
        with self.assertRaises(subprocess.CalledProcessError):
            self.publish(runner=runner)
        self.assertEqual((self.base / 'current').resolve(), self.previous)
        self.assertEqual(self.nginx.read_text(), self.old_config)
        self.assertEqual(self.commands[-2:], [['nginx', '-t'], ['systemctl', 'reload', 'nginx']])
        self.assertEqual(list((self.base / 'releases').iterdir()), [self.previous])

    def test_failed_nginx_reload_restores_config_before_frontend_publication(self):
        def runner(command):
            self.commands.append(command)
            if len(self.commands) == 2:
                raise subprocess.CalledProcessError(1, command)
        with self.assertRaises(subprocess.CalledProcessError):
            self.publish(runner=runner)
        self.assertEqual((self.base / 'current').resolve(), self.previous)
        self.assertEqual(self.nginx.read_text(), self.old_config)
        self.assertEqual(self.commands[-2:], [['nginx', '-t'], ['systemctl', 'reload', 'nginx']])

    def test_failed_origin_probe_restores_both_routing_and_frontend(self):
        def probe():
            self.assertNotEqual((self.base / 'current').resolve(), self.previous)
            raise RuntimeError('Origin is unhealthy')
        with self.assertRaisesRegex(RuntimeError, 'Origin is unhealthy'):
            self.publish(probe=probe)
        self.assertEqual((self.base / 'current').resolve(), self.previous)
        self.assertEqual(self.nginx.read_text(), self.old_config)

    def test_dry_run_does_not_create_a_release_or_change_configuration(self):
        result = self.publish(dry_run=True)
        self.assertTrue(result['dry_run'])
        self.assertEqual(list((self.base / 'releases').iterdir()), [self.previous])
        self.assertEqual(self.nginx.read_text(), self.old_config)
        self.assertEqual(self.commands, [])

    def test_origin_probe_retries_a_transient_worker_reload_and_completes(self):
        elapsed, attempts = [0.0], []
        def check(deadline):
            attempts.append(deadline)
            if len(attempts) < 3:
                raise publication.OriginVerificationError('Old worker lacks the security headers')
            return 'all checks passed'
        def pause(seconds):
            elapsed[0] += seconds
        result = publication.retry_origin_probe(check, now=lambda: elapsed[0], pause=pause)
        self.assertEqual(result, 'all checks passed')
        self.assertEqual(attempts, [5.0, 5.0, 5.0])
        self.assertEqual(elapsed[0], 0.5)

    def test_permanent_origin_probe_failure_remains_bounded_and_rolls_back(self):
        elapsed, attempts = [0.0], []
        failure = publication.OriginVerificationError('Security headers remain missing')
        def check(deadline):
            attempts.append(deadline)
            raise failure
        def pause(seconds):
            elapsed[0] += seconds
        def probe():
            publication.retry_origin_probe(check, now=lambda: elapsed[0], pause=pause)
        with self.assertRaises(publication.OriginVerificationError) as raised:
            self.publish(probe=probe)
        self.assertIs(raised.exception, failure)
        self.assertEqual(elapsed[0], 5.0)
        self.assertEqual(len(attempts), 20)
        self.assertEqual((self.base / 'current').resolve(), self.previous)
        self.assertEqual(self.nginx.read_text(), self.old_config)

    def test_unsafe_export_and_private_contract_fail_before_any_change(self):
        unsafe = self.source / 'linked-secret'
        unsafe.symlink_to(self.nginx)
        with self.assertRaisesRegex(ValueError, 'link or special'):
            self.publish()
        unsafe.unlink()
        (self.source / 'docs/api/openapi.json').write_text(json.dumps({
            'openapi': '3.0.3', 'paths': {'/v1/admin/users': {}}}))
        with self.assertRaisesRegex(ValueError, 'private API route'):
            self.publish()
        self.assertEqual((self.base / 'current').resolve(), self.previous)
        self.assertEqual(self.nginx.read_text(), self.old_config)
        self.assertEqual(self.commands, [])


if __name__ == '__main__':
    unittest.main()
