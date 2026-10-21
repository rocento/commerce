import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('image_cleanup', Path(__file__).resolve().parents[1] / 'cleanup-demo-backend-images.py')
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)


class BackendImageCleanupTests(unittest.TestCase):
    def run_cleanup(self, unhealthy=False, old_running=False, stopped_old=False, target_service="api-gateway", missing=False):
        containers = [dict(Image=cleanup.SERVICES[service], State=dict(Running=True, Health=dict(Status='healthy')),
                           Config=dict(Labels={'com.docker.compose.project':'rocento-' + store,
                                               'com.docker.compose.service':service}))
                      for store in cleanup.STORES for service in cleanup.SERVICES]
        target = next(c for c in containers if c['Config']['Labels']['com.docker.compose.service'] == target_service)
        if missing:
            containers.remove(target)
        if unhealthy:
            target['State']['Health']['Status'] = 'unhealthy'
        if old_running:
            target['Image'] = 'old'
        if stopped_old:
            containers.append(dict(Image='old', State=dict(Running=False), Config=dict(Labels={})))
        removed = []
        def docker(*args):
            if args[:2] == ('image', 'inspect'):
                return json.dumps([dict(Id=args[2] if args[2] in cleanup.SERVICES.values() else 'old')])
            if args[:2] == ('ps', '-aq'): return 'a b c'
            if args[0] == 'inspect': return json.dumps(containers)
            if args[:2] == ('image', 'ls'):
                return '\n'.join([f'rocento-{store}-{service}:latest' for store in cleanup.STORES for service in cleanup.SERVICES] + list(cleanup.SERVICES.values()) + ['postgres:16', 'custom:backup', 'rocento-rollback-grocery-ai-service:backup'])
            if args[:2] == ('image', 'rm'):
                self.assertEqual(len(args), 3)
                removed.append(args[2])
                return ''
            self.fail(args)
        with patch.object(cleanup, 'docker', side_effect=docker): cleanup.clean()
        return removed

    def test_removes_only_exact_unused_legacy_tags(self):
        self.assertEqual(self.run_cleanup(), [f'rocento-{store}-{service}:latest' for store in cleanup.STORES for service in cleanup.SERVICES])

    def test_preserves_images_until_all_stores_are_healthy_on_shared_release(self):
        self.assertEqual(self.run_cleanup(unhealthy=True), [])
        self.assertEqual(self.run_cleanup(old_running=True), [])

    def test_preserves_images_referenced_by_stopped_containers(self):
        self.assertEqual(self.run_cleanup(stopped_old=True), [])

    def test_every_ai_service_must_be_present_healthy_and_on_its_own_shared_image(self):
        for service in ('ai-service', 'commerce-language-engine', 'ai-postgres'):
            with self.subTest(service=service):
                self.assertEqual(self.run_cleanup(target_service=service, unhealthy=True), [])
                self.assertEqual(self.run_cleanup(target_service=service, old_running=True), [])
                self.assertEqual(self.run_cleanup(target_service=service, missing=True), [])
