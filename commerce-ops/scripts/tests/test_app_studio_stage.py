import copy
from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

RELEASE = Path(__file__).resolve().parents[1] / 'release'
sys.path.insert(0, str(RELEASE))
import app_studio_stage as stage


class StagePolicyTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.now = datetime.now(timezone.utc)
        self.prior = {str(i): 'a' * 96 for i in range(102)}
        self.commerce = {**self.prior, stage.MIGRATION: 'b' * 96}
        self.before = 'location ' + stage.OLD_ROUTE
        self.files = {}
        def artifact(name, content):
            p = self.root / name
            p.write_text(content)
            return {'path': name, 'sha256': stage.sha256(p)}
        evidence = artifact('evidence.json', '{}')
        source = artifact('source.json', json.dumps({'commerce': self.commerce, 'engagement': {},
                                                   'gateway_source_sha256': 'a'*64, 'base_image': 'sha256:'+'b'*64}))
        image = {'image': 'sha256:' + 'c'*64, 'binaries': {'api-gateway': 'd'*64}, 'source': source}
        self.inv = {'policy': 'app-studio-stage-v1', 'environment': 'apps.rocento.com', 'store': 'grocery',
                    'scope': ['grocery-api-gateway', 'app-studio-asset-ingress', stage.MIGRATION],
                    'prior': {'commerce': self.prior, 'engagement': {}, 'ingress': '', 'config': {}},
                    'prior_compose': artifact('compose.json', '{}'),
                    'candidate': image, 'fallback': copy.deepcopy(image), 'commerce': self.commerce, 'engagement': {},
                    'ingress': {'before': artifact('before.conf', self.before),
                                'after': artifact('after.conf', self.before.replace(stage.OLD_ROUTE, stage.NEW_ROUTE))},
                    'acceptance': artifact('acceptance.py', 'print("{}")'),
                    'checks': {n: {'status': 'passed', 'completed_at': self.now.isoformat(),
                                   'coverage': 'Exact fixture', 'evidence': [evidence],
                                   'candidate_image': image['image'], 'fallback_image': image['image']} for n in stage.CHECKS},
                    'deferrals': ['backups', 'disaster-recovery'],
                    'limitations': ['not-full-production-readiness', 'capacity-unqualified'],
                    'activation_sha256': stage.sha256(Path(stage.__file__))}
        self.inv['prior']['config']['deploy/ec2/grocery.yaml'] = self.inv['prior_compose']['sha256']
        self.inv['prior']['ingress'] = self.inv['ingress']['before']['sha256']
        self.protection = patch.object(stage, 'protected')
        self.protection.start()
        self.addCleanup(self.protection.stop)
        self.images = patch.object(stage, 'image_check')
        self.images.start()
        self.addCleanup(self.images.stop)

    def validate(self):
        stage.validate_inventory(self.inv, self.root, self.now)

    def test_valid_scoped_inventory(self):
        self.validate()

    def test_full_scope_rejected(self):
        self.inv['scope'].append('workers')
        with self.assertRaisesRegex(ValueError, 'scope'):
            self.validate()

    def test_unknown_field_rejected(self):
        self.inv['skip_checks'] = True
        with self.assertRaises(ValueError):
            self.validate()

    def test_missing_security_check_rejected(self):
        del self.inv['checks']['security-review']
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            self.validate()

    def test_stale_evidence_rejected(self):
        self.inv['checks']['banner-schema']['completed_at'] = (self.now-timedelta(days=2)).isoformat()
        with self.assertRaisesRegex(ValueError, 'stale'):
            self.validate()

    def test_evidence_tampering_rejected(self):
        (self.root / 'evidence.json').write_text('changed')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            self.validate()

    def test_ingress_scope_expansion_rejected(self):
        p = self.root / 'after.conf'
        p.write_text(p.read_text() + '\nlocation /admin {}')
        self.inv['ingress']['after']['sha256'] = stage.sha256(p)
        with self.assertRaisesRegex(ValueError, 'ingress exceeds'):
            self.validate()

    def test_unapproved_deferral_rejected(self):
        self.inv['deferrals'].append('security')
        with self.assertRaisesRegex(ValueError, 'deferrals'):
            self.validate()

    def test_changed_activation_code_rejected(self):
        self.inv['activation_sha256'] = '0'*64
        with self.assertRaisesRegex(ValueError, 'code differs'):
            self.validate()

    def test_changed_applied_migration_rejected(self):
        self.inv['prior']['commerce']['1'] = 'f'*96
        with self.assertRaisesRegex(ValueError, 'changed applied'):
            self.validate()

    def test_extra_migration_rejected(self):
        self.inv['commerce']['20990101000000'] = 'e'*96
        with self.assertRaises(ValueError):
            self.validate()

    def test_fallback_worker_change_rejected(self):
        self.inv['candidate']['binaries']['export-worker'] = 'a'*64
        self.inv['fallback']['binaries']['export-worker'] = 'b'*64
        with self.assertRaisesRegex(ValueError, 'retained binary'):
            self.validate()

    def test_packet_path_traversal_rejected(self):
        with self.assertRaisesRegex(ValueError, 'direct child'):
            stage.packet_file(self.root, {'path': '../escape', 'sha256': 'a'*64})

    def test_unchanged_workers_guard(self):
        prior = {'machine': 'm', 'frontend': {}, 'engagement': {}, 'commerce': self.commerce,
                 'config': {'deploy/ec2/grocery.yaml': 'before', 'compose.yaml': 'same'},
                 'containers': {'worker': {'id': '1', 'image': 'a'}}}
        self.inv['prior'] = prior
        current = copy.deepcopy(prior)
        current['containers']['worker']['id'] = '2'
        with patch.object(stage, 'state', return_value=current):
            with self.assertRaisesRegex(ValueError, 'unrelated container'):
                stage.preserved(self.inv)


    def test_failed_acceptance_rejected(self):
        with self.assertRaises(ValueError):
            stage.acceptance_result(json.dumps({'passed': False, 'checks': {}, 'details': {}}))

    def test_incomplete_acceptance_rejected(self):
        with self.assertRaises(ValueError):
            stage.acceptance_result(json.dumps({'passed': True, 'checks': {'auth_login': True}, 'details': {}}))

    def test_valid_acceptance(self):
        result = {'passed': True, 'checks': {n: True for n in stage.ACCEPTANCE}, 'details': {}}
        self.assertEqual(stage.acceptance_result(json.dumps(result)), result)

    def test_ingress_recovery_attempted_after_gateway_failure(self):
        with patch.object(stage, 'compose', side_effect=RuntimeError('gateway failed')), \
             patch.object(stage.shutil, 'copyfile') as ingress, \
             patch.object(stage, 'run'), patch.object(stage, 'preserved'):
            with self.assertRaisesRegex(ValueError, 'gateway recovery'):
                stage.recover(self.inv, self.root)
            ingress.assert_called_once()

    def test_gateway_recovery_not_skipped_for_ingress_failure(self):
        with patch.object(stage, 'compose') as gateway, \
             patch.object(stage.shutil, 'copyfile', side_effect=RuntimeError('ingress failed')), \
             patch.object(stage, 'run'), patch.object(stage, 'preserved') as verify:
            with self.assertRaisesRegex(ValueError, 'ingress recovery'):
                stage.recover(self.inv, self.root)
            gateway.assert_called_once_with(self.inv['fallback']['image'])
            verify.assert_called_once()

    def test_recovery_health_failure_rejected(self):
        with patch.object(stage, 'compose'), patch.object(stage.shutil, 'copyfile'), \
             patch.object(stage, 'run'), patch.object(stage, 'preserved', side_effect=ValueError('unhealthy')):
            with self.assertRaisesRegex(ValueError, 'recovery verification'):
                stage.recover(self.inv, self.root)

    def test_protected_rejects_writable_file(self):
        self.protection.stop()
        p = self.root / 'writable'
        p.write_text('x')
        p.chmod(0o666)
        with self.assertRaises(ValueError):
            stage.protected(p)


if __name__ == '__main__':
    unittest.main()
