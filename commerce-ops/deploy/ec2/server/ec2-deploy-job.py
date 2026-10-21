#!/usr/bin/env python3
"""Keep full EC2 deployments alive across SSH disconnects and report their result."""
import argparse
import base64
import json
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import time

JOBS = Path('/var/log/rocento/deployments/jobs')
STAGING = Path('/home/ubuntu/.rocento-deploy')
CHUNK = 65536


def repository_root():
    """Find the checkout root only for commands that use the active checkout."""
    for parent in Path(__file__).resolve().parents:
        if (parent / 'commerce-api/rocento-api/Cargo.toml').is_file():
            return parent
    raise RuntimeError('Cannot locate the commerce repository root')


def job_path(job):
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9-]{0,63}', job):
        raise ValueError('Invalid deployment job ID')
    return JOBS / job


def source_path(job, source):
    job_path(job)
    expected = STAGING / job
    if Path(source) != expected:
        raise ValueError('Staging directory must match the deployment job ID')
    return expected


def start(job, source=None):
    if source is not None:
        staged = source_path(job, source)
        if staged.resolve() != staged or not (staged / 'ready').is_file():
            raise ValueError('Staged deployment is incomplete or uses a symlink')
    directory = job_path(job)
    # Never replace an existing job or execute its deployment a second time.
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    runner = Path(__file__).resolve()
    options = []
    if source is not None:
        # Status and recovery must survive source activation and stage cleanup.
        runner = directory / 'runner.py'
        shutil.copyfile(__file__, runner)
        options = ['--source', str(staged)]
    result = subprocess.run([
        'systemd-run', '--quiet', '--collect', f'--unit=rocento-deploy-{job}',
        '--property=Type=exec', sys.executable, str(runner),
        'run', job, *options,
    ], capture_output=True, text=True)
    if result.returncode:
        (directory / 'exit-code').write_text(str(result.returncode))
        (directory / 'output.log').write_text(result.stderr)
    print(json.dumps({'job': job, 'launch_exit_code': result.returncode}))
    return result.returncode


def run(job, source=None):
    directory = job_path(job)
    staged = source_path(job, source) if source is not None else None
    # A staged deployment copies this runner into its durable job directory.
    # In that case the staged source is the root and this file is no longer
    # beneath a checkout, so repository discovery must stay lazy.
    root = staged / 'source' if staged is not None else repository_root()
    script = 'ec2-activate-source.sh' if staged is not None else 'ec2-up.sh'
    code = 1
    with (directory / 'output.log').open('ab', buffering=0) as log:
        try:
            code = subprocess.run(
                ['bash', str(root / 'commerce-ops/deploy/ec2/server' / script)], cwd=root,
                stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
            ).returncode
            if code < 0:
                code = 128 - code
            if code == 0 and staged is not None:
                # The root-owned job runner/log remain available for --resume.
                try:
                    shutil.rmtree(staged)
                except OSError as error:
                    log.write(f'Warning: could not remove completed stage: {error}\n'.encode())
        except OSError as error:
            log.write(f'Could not run deployment: {error}\n'.encode())
        finally:
            temporary = directory / 'exit-code.tmp'
            temporary.write_text(str(code))
            temporary.replace(directory / 'exit-code')
    return code


def status(job, offset):
    directory = job_path(job)
    if offset < 0:
        raise ValueError('Log offset must be nonnegative')
    result = directory / 'exit-code'
    active = None
    if directory.exists() and not result.exists():
        active = subprocess.run([
            'systemctl', 'is-active', f'rocento-deploy-{job}.service',
        ], capture_output=True, text=True).stdout.strip()
    # Read completion after querying systemd to avoid racing a completed unit.
    # Then read the log so a completed response includes the final output.
    code = int(result.read_text()) if result.exists() else None
    content = b''
    log = directory / 'output.log'
    if log.exists():
        with log.open('rb') as stream:
            stream.seek(offset)
            content = stream.read(CHUNK)
    state = 'complete' if code is not None else 'running'
    if not directory.exists():
        state = 'missing'
    elif code is None and active not in ('active', 'activating', 'reloading'):
        state = 'interrupted'
    print(json.dumps({
        'state': state, 'exit_code': code, 'offset': offset + len(content),
        'output': base64.b64encode(content).decode(), 'more': len(content) == CHUNK,
    }))
    return 0


def monitor(job, ssh, launch=True, poll_seconds=3, source=None):
    job_path(job)
    command = 'sudo -n python3 /opt/rocento/deploy/ec2/server/ec2-deploy-job.py'
    launch_command = command
    source_options = []
    if source is not None:
        staged = source_path(job, source)
        command = f'sudo -n python3 {shlex.quote(str(job_path(job) / "runner.py"))}'
        launch_command = f'sudo -n python3 {shlex.quote(str(staged / "source/commerce-ops/deploy/ec2/server/ec2-deploy-job.py"))}'
        source_options = ['--source', str(staged)]
    recovery = shlex.join([
        sys.executable, str(Path(__file__).resolve()), 'monitor', job, '--resume',
        *source_options, '--ssh', *ssh,
    ])
    print(f'[INFO] Remote deployment job: {job}\n'
          f'[INFO] Server log: {JOBS / job / "output.log"}\n'
          f'[INFO] Reconnect without restarting deployment: {recovery}', flush=True)
    if launch:
        result = subprocess.run([*ssh, f'{launch_command} start {shlex.quote(job)}'
                                 + (f' --source {shlex.quote(str(staged))}' if source is not None else '')], capture_output=True)
        if result.returncode not in (0, 255):
            sys.stderr.buffer.write(result.stderr)
            return result.returncode
        if result.returncode == 255:
            print('[INFO] SSH disconnected during launch; checking the same job without launching again.', flush=True)
    offset = 0
    failures = 0
    while True:
        result = subprocess.run([*ssh, f'{command} status {shlex.quote(job)} {offset}'], capture_output=True)
        if result.returncode:
            failures += 1
            if result.returncode != 255 or failures >= 3:
                sys.stderr.buffer.write(result.stderr)
                print(f'ERROR: Cannot read remote deployment result. The job may still be running.\n'
                      f'Reconnect with: {recovery}', file=sys.stderr)
                return result.returncode
            print('[INFO] SSH interrupted; reconnecting to the existing deployment job.', flush=True)
            time.sleep(poll_seconds)
            continue
        try:
            report = json.loads(result.stdout)
            output = base64.b64decode(report['output'], validate=True)
            next_offset = int(report['offset'])
            if next_offset != offset + len(output):
                raise ValueError('Invalid remote log offset')
        except (ValueError, KeyError, TypeError) as error:
            print(f'ERROR: Invalid deployment status: {error}. Reconnect with: {recovery}', file=sys.stderr)
            return 1
        failures = 0
        sys.stdout.buffer.write(output)
        sys.stdout.buffer.flush()
        offset = next_offset
        if report['more']:
            continue
        if report['state'] == 'complete':
            code = int(report['exit_code'])
            print(f'[INFO] Remote deployment finished with exit {code}.', flush=True)
            return code
        if report['state'] != 'running':
            print(f'ERROR: Remote deployment job is {report["state"]}. '
                  f'Inspect {JOBS / job} before starting another deployment.', file=sys.stderr)
            return 1
        time.sleep(poll_seconds)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('start', 'run', 'status', 'monitor'))
    parser.add_argument('job')
    parser.add_argument('offset', nargs='?', type=int, default=0)
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--source', help='Isolated staged upload for this job')
    parser.add_argument('--ssh', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.action == 'monitor':
        if not args.ssh:
            parser.error('--ssh requires the SSH executable, options and destination')
        return monitor(args.job, args.ssh, launch=not args.resume, source=args.source)
    if args.action == 'start':
        return start(args.job, source=args.source)
    if args.action == 'run':
        return run(args.job, source=args.source)
    return status(args.job, args.offset)


if __name__ == '__main__':
    sys.exit(main())
