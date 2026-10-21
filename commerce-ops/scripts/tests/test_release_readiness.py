"""Fail-closed release evidence policy; no external services or credentials."""
import copy
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
import re
import textwrap
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'release/release_readiness.py'
SPEC = importlib.util.spec_from_file_location('readiness', SCRIPT)
readiness = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(readiness)


class ReadinessTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.candidate = 'a' * 64
        self.now = datetime(2026, 10, 15, 12, tzinfo=timezone.utc)
        (self.root / 'report.json').write_text('{"passed":true}')
        digest = hashlib.sha256((self.root / 'report.json').read_bytes()).hexdigest()
        self.packet = readiness.template(self.candidate, 'acceptance-eu', 'release-owner')
        for check in self.packet['checks']:
            check.update(status='passed', command='verified command', reviewer='service-owner',
                         coverage='synthetic acceptance', completed_at='2026-10-15T10:00:00Z',
                         evidence=[{'path': 'report.json', 'sha256': digest}])
        self.packet['approval'] = dict(reviewer='release-reviewer', candidate_sha256=self.candidate,
                                       environment='acceptance-eu', approved_at='2026-10-15T11:00:00Z')

    def validate(self, packet=None):
        return readiness.validate(packet or self.packet, self.root, self.candidate, 'acceptance-eu', self.now)

    def test_complete_packet(self):
        self.assertEqual(self.validate(), [])

    def test_all_required_checks_cannot_be_omitted_or_skipped(self):
        for index, name in enumerate(readiness.REQUIRED_CHECKS):
            for status in ('missing', 'skipped', 'failed', 'pending'):
                with self.subTest(check=name, status=status):
                    packet = copy.deepcopy(self.packet)
                    if status == 'missing':
                        packet['checks'].pop(index)
                    else:
                        packet['checks'][index]['status'] = status
                    self.assertTrue(self.validate(packet))

    def test_check_identity_metadata_and_time(self):
        for field, value in [('candidate_sha256', 'b' * 64), ('environment', 'other'),
                             ('completed_at', '2026-10-10T10:00:00Z'),
                             ('completed_at', '2026-10-16T10:00:00Z'),
                             ('completed_at', '2026-10-15T10:00:00'),
                             ('completed_at', None), ('reviewer', ''), ('coverage', ''),
                             ('command', ''), ('evidence', [])]:
            with self.subTest(field=field, value=value):
                packet = copy.deepcopy(self.packet)
                packet['checks'][0][field] = value
                self.assertTrue(self.validate(packet))

    def test_artifact_tampering_and_missing_file(self):
        (self.root / 'report.json').write_text('changed')
        self.assertTrue(self.validate())
        (self.root / 'report.json').unlink()
        self.assertTrue(self.validate())

    def test_path_escape_and_symlinks(self):
        (self.root / 'link').symlink_to(self.root / 'report.json')
        (self.root / 'linked-dir').symlink_to(self.root, target_is_directory=True)
        for path in ('../report.json', str(self.root / 'report.json'), 'link', 'linked-dir/report.json'):
            with self.subTest(path=path):
                packet = copy.deepcopy(self.packet)
                packet['checks'][0]['evidence'][0]['path'] = path
                self.assertTrue(self.validate(packet))

    def test_approval_must_be_independent_current_and_bound(self):
        for field, value in [('reviewer', 'release-owner'), ('reviewer', ''),
                             ('candidate_sha256', 'b' * 64), ('environment', 'other'),
                             ('approved_at', '2026-10-15T09:00:00Z'),
                             ('approved_at', '2026-10-16T10:00:00Z')]:
            with self.subTest(field=field):
                packet = copy.deepcopy(self.packet)
                packet['approval'][field] = value
                self.assertTrue(self.validate(packet))
        self.packet['approval'] = None
        self.assertTrue(self.validate())

    def test_unknown_duplicate_and_malformed_checks(self):
        for entry in (self.packet['checks'][0], {'id': 'invented'}, None, {'id': []}):
            with self.subTest(entry=entry):
                packet = copy.deepcopy(self.packet)
                packet['checks'].append(entry)
                self.assertTrue(self.validate(packet))

    def test_cli_template_blocks_and_refuses_overwrite(self):
        path = self.root / 'packet.json'
        base = [sys.executable, str(SCRIPT)]
        args = ['--packet', str(path), '--candidate-sha256', self.candidate, '--environment', 'acceptance-eu']
        result = subprocess.run(base + ['init', *args, '--owner', 'owner'], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        result = subprocess.run(base + ['check', *args], capture_output=True)
        self.assertEqual(result.returncode, 1)
        self.assertFalse(json.loads(result.stdout)['ready'])
        before = path.read_bytes()
        result = subprocess.run(base + ['init', *args, '--owner', 'owner'], capture_output=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(path.read_bytes(), before)
        path.write_text('{"schema_version":1,"schema_version":1}')
        result = subprocess.run(base + ['check', *args], capture_output=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn('duplicate JSON key', result.stdout.decode())


class RequiredCiTests(unittest.TestCase):
    def test_aggregator_covers_every_job_and_rejects_non_success(self):
        workflow = (SCRIPT.parents[3] / '.github/workflows/ci.yml').read_text()
        jobs_section = workflow.split('jobs:', 1)[1]
        jobs = set(re.findall(r'^  ([a-z][a-z0-9-]*):$', jobs_section, re.MULTILINE))
        gate = jobs_section.split('  required-ci:', 1)[1]
        needed = set(re.search(r'needs: \[(.*?)\]', gate).group(1).replace(' ', '').split(','))
        self.assertEqual(needed, jobs - {'required-ci'})
        self.assertIn('if: always()', gate)
        script = textwrap.dedent(gate.split("python3 - <<'PY'\n", 1)[1].rsplit('          PY', 1)[0])
        for status in ('success', 'failure', 'cancelled', 'skipped'):
            with self.subTest(status=status):
                results = {name: {'result': 'success'} for name in needed}
                results['backend']['result'] = status
                result = subprocess.run([sys.executable, '-c', script], capture_output=True,
                                        env={**os.environ, 'RESULTS': json.dumps(results)})
                self.assertEqual(result.returncode, 0 if status == 'success' else 1, result.stderr)


if __name__ == '__main__':
    unittest.main()
