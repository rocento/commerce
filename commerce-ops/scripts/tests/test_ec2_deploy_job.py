"""Test deployment disconnects without running production commands."""
import base64
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('deploy_job', ROOT / 'commerce-ops/deploy/ec2/server/ec2-deploy-job.py')
job = importlib.util.module_from_spec(spec)
spec.loader.exec_module(job)


class Output(io.TextIOWrapper):
    def __init__(self):
        super().__init__(io.BytesIO(), encoding='utf-8', write_through=True)

    def value(self):
        self.flush()
        return self.buffer.getvalue().decode()


def reply(state='complete', code=0, output=b'', offset=0, more=False):
    return subprocess.CompletedProcess([], 0, json.dumps({
        'state': state, 'exit_code': code, 'output': base64.b64encode(output).decode(),
        'offset': offset + len(output), 'more': more,
    }).encode(), b'')


class MonitorTests(unittest.TestCase):
    def monitor(self, replies, resume=False, source=None):
        output, error = Output(), Output()
        with patch.object(job.subprocess, 'run', side_effect=replies) as run, \
             patch.object(job.time, 'sleep'), \
             contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
            code = job.monitor('test-job', ['ssh', 'test-host'], launch=not resume, source=source)
        return code, run.call_args_list, output.value(), error.value()

    def test_disconnect_reconnects_without_relaunch_or_duplicate_output(self):
        code, calls, output, error = self.monitor([
            subprocess.CompletedProcess([], 0, b'', b''),
            reply('running', None, b'first\n'),
            subprocess.CompletedProcess([], 255, b'', b'broken pipe'),
            reply(output=b'last\n', offset=6),
        ])
        self.assertEqual(code, 0, error)
        commands = [call.args[0][-1] for call in calls]
        self.assertEqual(sum(' start ' in c for c in commands), 1)
        self.assertTrue(commands[2].endswith('test-job 6'))
        self.assertTrue(commands[3].endswith('test-job 6'))
        self.assertEqual(output.count('first\n'), 1)
        self.assertEqual(output.count('last\n'), 1)

    def test_launch_disconnect_only_checks_existing_job(self):
        code, calls, _, _ = self.monitor([
            subprocess.CompletedProcess([], 255, b'', b''), reply(),
        ])
        self.assertEqual(code, 0)
        self.assertEqual(sum(' start ' in c.args[0][-1] for c in calls), 1)

    def test_build_failure_propagates_after_draining_all_log_chunks(self):
        code, _, output, error = self.monitor([
            subprocess.CompletedProcess([], 0, b'', b''),
            reply(code=2, output=b'first\n', more=True),
            reply(code=2, output=b'type error\n', offset=6),
        ])
        self.assertEqual(code, 2, error)
        self.assertIn('type error', output)

    def test_repeated_disconnect_reports_uncertain_result_and_resume_command(self):
        disconnected = subprocess.CompletedProcess([], 255, b'', b'broken pipe')
        code, calls, _, error = self.monitor([disconnected] * 4)
        self.assertEqual(code, 255)
        self.assertEqual(sum(' start ' in c.args[0][-1] for c in calls), 1)
        self.assertIn('may still be running', error)
        self.assertIn('--resume', error)

    def test_resume_never_launches(self):
        code, calls, _, _ = self.monitor([reply()], resume=True)
        self.assertEqual(code, 0)
        self.assertFalse(any(' start ' in c.args[0][-1] for c in calls))

    def test_staged_monitor_uses_persistent_runner_and_resumes_after_stage_removal(self):
        source = str(job.STAGING / 'test-job')
        code, calls, output, error = self.monitor([
            subprocess.CompletedProcess([], 0, b'', b''), reply(),
        ], source=source)
        self.assertEqual(code, 0, error)
        self.assertIn(source + '/source/commerce-ops/deploy/ec2/server/ec2-deploy-job.py start test-job', calls[0].args[0][-1])
        self.assertIn('--source ' + source, calls[0].args[0][-1])
        self.assertIn(str(job.JOBS / 'test-job/runner.py') + ' status test-job', calls[1].args[0][-1])
        self.assertIn('--resume --source ' + source, output)
        code, calls, _, error = self.monitor([reply()], resume=True, source=source)
        self.assertEqual(code, 0, error)
        self.assertNotIn(source, calls[0].args[0][-1])

    def test_missing_job_is_not_reported_as_success_or_relaunched(self):
        code, calls, _, error = self.monitor([reply('missing', None)], resume=True)
        self.assertEqual(code, 1)
        self.assertEqual(len(calls), 1)
        self.assertIn('missing', error)


class WorkerTests(unittest.TestCase):
    def test_staged_worker_records_failure_and_only_cleans_successful_uploads(self):
        for expected in (0, 7):
            with self.subTest(exit_code=expected), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                stage = root / 'staging/test-job'
                (stage / 'source/commerce-ops/deploy/ec2/server').mkdir(parents=True)
                (stage / 'source/commerce-ops/deploy/ec2/server/ec2-activate-source.sh').write_text(f'echo activated\nexit {expected}\n')
                (root / 'jobs/test-job').mkdir(parents=True)
                with patch.object(job, 'JOBS', root / 'jobs'), patch.object(job, 'STAGING', root / 'staging'):
                    self.assertEqual(job.run('test-job', source=str(stage)), expected)
                self.assertEqual(stage.exists(), expected != 0)
                self.assertEqual((root / 'jobs/test-job/exit-code').read_text(), str(expected))
                self.assertEqual((root / 'jobs/test-job/output.log').read_text(), 'activated\n')

    def test_staged_start_requires_complete_matching_upload_and_saves_runner(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            stage = root / 'staging/test-job'
            stage.mkdir(parents=True)
            with patch.object(job, 'JOBS', root / 'jobs'), patch.object(job, 'STAGING', root / 'staging'), \
                 patch.object(job.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')) as run, \
                 contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(ValueError):
                    job.start('test-job', source=str(stage))
                with self.assertRaises(ValueError):
                    job.start('test-job', source=str(root))
                run.assert_not_called()
                (stage / 'ready').touch()
                self.assertEqual(job.start('test-job', source=str(stage)), 0)
                runner = root / 'jobs/test-job/runner.py'
                self.assertEqual(runner.read_text(), Path(job.__file__).read_text())
                self.assertIn(str(runner), run.call_args.args[0])
                self.assertEqual(run.call_args.args[0][-2:], ['--source', str(stage)])

    def test_worker_records_actual_exit_and_log(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'deploy/ec2/server').mkdir(parents=True)
            (root / 'deploy/ec2/server/ec2-up.sh').write_text('echo build-failed\nexit 2\n')
            (root / 'jobs/test-job').mkdir(parents=True)
            with patch.object(job, 'ROOT', root), patch.object(job, 'JOBS', root / 'jobs'):
                self.assertEqual(job.run('test-job'), 2)
            self.assertEqual((root / 'jobs/test-job/exit-code').read_text(), '2')
            self.assertEqual((root / 'jobs/test-job/output.log').read_text(), 'build-failed\n')

    def test_start_uses_systemd_and_refuses_duplicate_job(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(job, 'JOBS', Path(directory)), \
             patch.object(job.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')) as run, \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(job.start('test-job'), 0)
            command = run.call_args.args[0]
            self.assertEqual(command[0], 'systemd-run')
            self.assertEqual(command[-2:], ['run', 'test-job'])
            with self.assertRaises(FileExistsError):
                job.start('test-job')
            self.assertEqual(run.call_count, 1)

    def test_status_reads_chunks_and_detects_interrupted_unit(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(job, 'JOBS', Path(directory)):
            path = Path(directory) / 'test-job'
            path.mkdir()
            (path / 'output.log').write_bytes(b'a' * (job.CHUNK + 5))
            (path / 'exit-code').write_text('0')
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                job.status('test-job', job.CHUNK)
            report = json.loads(output.getvalue())
            self.assertEqual(base64.b64decode(report['output']), b'a' * 5)
            self.assertEqual(report['state'], 'complete')
            (path / 'exit-code').unlink()
            with patch.object(job.subprocess, 'run', return_value=subprocess.CompletedProcess([], 3, 'inactive\n', '')), \
                 contextlib.redirect_stdout(output := io.StringIO()):
                job.status('test-job', 0)
            self.assertEqual(json.loads(output.getvalue())['state'], 'interrupted')

    def test_job_id_cannot_escape_log_directory(self):
        for value in ('../secret', 'x;reboot', '', '/tmp/job'):
            with self.assertRaises(ValueError):
                job.job_path(value)


if __name__ == '__main__':
    unittest.main()
