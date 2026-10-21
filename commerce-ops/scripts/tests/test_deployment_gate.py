"""Production gate rejects unreviewed sources before any deployment action."""
import contextlib
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'release'))
import deployment_gate as gate


class DeploymentGateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.auth = self.root / 'authorization.json'
        self.machine = self.root / 'machine-id'
        self.machine.write_text('synthetic-machine')
        self.source = self.root / 'source'
        self.source.mkdir()
        self.files = {'server.py': 'a' * 64}
        inventory = dict(schema_version=1, deployment=dict(operation='ai', service='all', store='all', preserve_ai=False),
                         source_files=self.files)
        (self.root / 'inventory.json').write_text(json.dumps(inventory))
        candidate = gate.sha256(self.root / 'inventory.json')
        self.auth.write_text(json.dumps(dict(candidate_sha256=candidate, environment='production-fixture',
                                            machine_id_sha256=gate.sha256(self.machine))))
        packet = gate.readiness.template(candidate, 'production-fixture', 'owner')
        report = self.root / 'result.json'
        report.write_text('{"passed":true}')
        now = datetime.now(timezone.utc)
        for check in packet['checks']:
            check.update(status='passed', command='fixture acceptance', reviewer='service-reviewer', coverage='fixture',
                         completed_at=(now-timedelta(minutes=2)).isoformat(),
                         evidence=[dict(path='result.json', sha256=gate.sha256(report))])
        packet['approval'] = dict(reviewer='independent-reviewer', candidate_sha256=candidate,
                                  environment='production-fixture', approved_at=(now-timedelta(minutes=1)).isoformat())
        (self.root / 'readiness.json').write_text(json.dumps(packet))

    def enforce(self, **kwargs):
        with patch.object(gate, 'protected'), patch.object(gate, 'check_artifacts'), patch.object(gate, 'source_inventory', return_value=self.files), contextlib.redirect_stdout(io.StringIO()):
            gate.enforce(self.source, 'ai', authorization=self.auth, machine_id=self.machine, **kwargs)

    def test_reviewed_packet_passes(self):
        self.enforce()

    def test_wrong_machine_candidate_environment_and_scope_block(self):
        original = self.auth.read_text()
        for field in ('machine_id_sha256', 'candidate_sha256', 'environment'):
            with self.subTest(field=field):
                auth = json.loads(original)
                auth[field] = 'wrong'
                self.auth.write_text(json.dumps(auth))
                with self.assertRaises(ValueError):
                    self.enforce()
        self.auth.write_text(original)
        with self.assertRaisesRegex(ValueError, 'scope'):
            self.enforce(store='grocery')

    def test_changed_or_added_source_blocks(self):
        self.files['new.py'] = 'b' * 64
        with self.assertRaisesRegex(ValueError, 'source differs'):
            self.enforce()

    def test_tampered_report_and_pending_evidence_block(self):
        (self.root / 'result.json').write_text('tampered')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            self.enforce()

    def test_missing_authorization_fails_closed(self):
        self.auth.unlink()
        with self.assertRaises(FileNotFoundError):
            self.enforce()

    def test_protection_checks_owner_permissions_and_symlink_for_all_ancestors(self):
        for bad in (SimpleNamespace(st_uid=1000, st_mode=stat.S_IFREG | 0o600),
                    SimpleNamespace(st_uid=0, st_mode=stat.S_IFREG | 0o666),
                    SimpleNamespace(st_uid=0, st_mode=stat.S_IFLNK | 0o777)):
            with self.subTest(bad=bad), patch.object(Path, 'lstat', return_value=bad):
                with self.assertRaisesRegex(ValueError, 'untrusted'):
                    gate.protected(Path('/etc/rocento/release/authorization.json'))

    def test_rengine_inventory_excludes_runtime_but_includes_new_source(self):
        for name in ('commerce-web/apps/rengine/server.mjs', 'commerce-ops/compose/compose.rengine.yaml',
                     'commerce-ops/deploy/rengine/nginx.conf', 'commerce-ops/deploy/ec2/server/ec2-deploy-rengine.sh',
                     'commerce-ops/scripts/release/deployment_gate.py', 'commerce-ops/scripts/release/release_readiness.py',
                     'commerce-web/apps/rengine/node_modules/cache', 'commerce-web/apps/rengine/.env'):
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('fixture')
        files = gate.source_inventory(self.source, 'rengine')
        self.assertIn('commerce-web/apps/rengine/server.mjs', files)
        self.assertNotIn('commerce-web/apps/rengine/.env', files)
        self.assertNotIn('commerce-web/apps/rengine/node_modules/cache', files)
        (self.source / 'commerce-web/apps/rengine/injected.mjs').symlink_to(self.source / 'commerce-web/apps/rengine/server.mjs')
        with self.assertRaisesRegex(ValueError, 'symlink'):
            gate.source_inventory(self.source, 'rengine')

    def test_artifact_gate_rejects_missing_and_retagged_images(self):
        inventory_path = self.root / 'inventory.json'
        inventory = json.loads(inventory_path.read_text())
        def save():
            inventory_path.write_text(json.dumps(inventory))
            auth = json.loads(self.auth.read_text())
            auth['candidate_sha256'] = gate.sha256(inventory_path)
            self.auth.write_text(json.dumps(auth))
        with patch.object(gate, 'protected'):
            with self.assertRaisesRegex(ValueError, 'missing or incomplete'):
                gate.check_artifacts('ai', 'all', False, authorization=self.auth)
            inventory['image_ids'] = {tag: 'sha256:' + 'a' * 64 for tag in gate.expected_tags('ai', 'all', False)}
            save()
            with patch.object(gate.subprocess, 'run', return_value=SimpleNamespace(stdout='sha256:' + 'b' * 64)):
                with self.assertRaisesRegex(ValueError, 'untested image'):
                    gate.check_artifacts('ai', 'all', False, authorization=self.auth)
            with patch.object(gate.subprocess, 'run', return_value=SimpleNamespace(stdout='sha256:' + 'a' * 64)), contextlib.redirect_stdout(io.StringIO()):
                gate.check_artifacts('ai', 'all', False, authorization=self.auth)

    def test_frontend_artifact_bytes_and_added_files_are_verified(self):
        frontend = self.root / 'commerce-web'
        frontend.mkdir()
        (frontend / 'index.html').write_text('reviewed')
        path = self.root / 'inventory.json'
        inventory = json.loads(path.read_text())
        inventory['image_ids'] = {}
        inventory['frontend_files'] = {'index.html': gate.sha256(frontend / 'index.html')}
        path.write_text(json.dumps(inventory))
        auth = json.loads(self.auth.read_text())
        auth['candidate_sha256'] = gate.sha256(path)
        self.auth.write_text(json.dumps(auth))
        with patch.object(gate, 'protected'), contextlib.redirect_stdout(io.StringIO()):
            gate.check_artifacts('website', 'all', False, frontend, self.auth)
            (frontend / 'extra.js').write_text('unreviewed')
            with self.assertRaisesRegex(ValueError, 'frontend artifact differs'):
                gate.check_artifacts('website', 'all', False, frontend, self.auth)

    def test_full_inventory_uses_upload_filters_and_includes_migrations(self):
        repository = Path(__file__).resolve().parents[3]
        names = ['commerce-ops/deploy/ec2/server/ec2-source-filters.sh', 'commerce-api/rocento-api/migrations/1.sql',
                 'commerce-api/src/main.rs', 'commerce-web/src/main.ts', 'commerce-api/rocento-api/target/cache',
                 'commerce-ops/deploy/ec2/bootstrap.env', 'commerce-ops/deploy/aws-deploy/private.key']
        for name in names:
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text((repository / name).read_text() if name.endswith('ec2-source-filters.sh') else 'fixture')
        files = gate.source_inventory(self.source, 'full')
        self.assertIn('commerce-api/rocento-api/migrations/1.sql', files)
        self.assertIn('commerce-api/src/main.rs', files)
        self.assertNotIn('commerce-api/rocento-api/target/cache', files)
        self.assertNotIn('commerce-ops/deploy/ec2/bootstrap.env', files)
        self.assertNotIn('commerce-ops/deploy/aws-deploy/private.key', files)
        (self.source / 'commerce-api/src/main.rs').write_text('changed')
        self.assertNotEqual(files, gate.source_inventory(self.source, 'full'))


if __name__ == '__main__':
    unittest.main()
