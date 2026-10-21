"""Validate reviewed, candidate-bound release evidence; never deploys services."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys

# Changing this policy requires code review, not an exception in a release packet.
REQUIRED_CHECKS = (
    'service-ci', 'commerce-image', 'browser-journeys', 'tenant-isolation',
    'security-review', 'migration-upgrade', 'backup-restore',
    'recovery-plan', 'capacity', 'observability', 'deployment-acceptance',
)
MAX_AGE_HOURS = 72
HEX = re.compile(r'[0-9a-f]{64}')


def timestamp(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('timestamp must include timezone')
    return parsed.astimezone(timezone.utc)


def nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def validate(packet, root, candidate, environment, now=None):
    """Return every blocker. Evidence producers/reviewers remain a trust boundary."""
    now = now or datetime.now(timezone.utc)
    blockers = []

    def require(condition, message):
        if not condition:
            blockers.append(message)

    require(packet.get('schema_version') == 1, 'unsupported schema_version')
    require(packet.get('candidate_sha256') == candidate, 'candidate mismatch')
    require(packet.get('environment') == environment, 'environment mismatch')
    require(nonempty(packet.get('owner')), 'release owner missing')
    checks = packet.get('checks')
    if not isinstance(checks, list):
        return blockers + ['checks must be a list']
    indexed = {}
    for check in checks:
        if not isinstance(check, dict) or check.get('id') not in REQUIRED_CHECKS:
            blockers.append('unknown or malformed check')
            continue
        name = check['id']
        require(name not in indexed, f'{name}: duplicate check')
        indexed[name] = check
    latest = None
    root = Path(root).resolve()
    for name in REQUIRED_CHECKS:
        check = indexed.get(name)
        if check is None:
            blockers.append(f'{name}: missing')
            continue
        require(check.get('status') == 'passed', f'{name}: not passed')
        require(check.get('candidate_sha256') == candidate, f'{name}: candidate mismatch')
        require(check.get('environment') == environment, f'{name}: environment mismatch')
        for field in ('command', 'reviewer', 'coverage'):
            require(nonempty(check.get(field)), f'{name}: {field} missing')
        try:
            completed = timestamp(check['completed_at'])
            age = (now - completed).total_seconds()
            require(0 <= age <= MAX_AGE_HOURS * 3600, f'{name}: stale or future evidence')
            latest = max(latest, completed) if latest else completed
        except (KeyError, ValueError, TypeError, AttributeError):
            blockers.append(f'{name}: invalid completed_at')
        evidence = check.get('evidence')
        if not isinstance(evidence, list) or not evidence:
            blockers.append(f'{name}: evidence missing')
            continue
        for item in evidence:
            try:
                relative = Path(item['path'])
                if relative.is_absolute() or '..' in relative.parts or not relative.parts:
                    raise ValueError('evidence must be a relative path within packet directory')
                path = root / relative
                if any(parent.is_symlink() for parent in [path, *path.parents] if parent != root):
                    raise ValueError('symlink evidence is forbidden')
                if not path.resolve().is_relative_to(root) or not path.is_file():
                    raise ValueError('evidence file missing or outside packet directory')
                expected = item['sha256']
                if not isinstance(expected, str) or not HEX.fullmatch(expected):
                    raise ValueError('invalid evidence checksum')
                sha = hashlib.sha256()
                with path.open('rb') as source:
                    for chunk in iter(lambda: source.read(1024 * 1024), b''):
                        sha.update(chunk)
                if sha.hexdigest() != expected:
                    raise ValueError('evidence checksum mismatch')
            except (KeyError, TypeError, ValueError, OSError) as error:
                blockers.append(f'{name}: {error}')
    approval = packet.get('approval')
    if not isinstance(approval, dict):
        blockers.append('release approval missing')
    else:
        require(nonempty(approval.get('reviewer')), 'approval reviewer missing')
        require(approval.get('reviewer') != packet.get('owner'), 'approval must be independent of release owner')
        require(approval.get('candidate_sha256') == candidate, 'approval candidate mismatch')
        require(approval.get('environment') == environment, 'approval environment mismatch')
        try:
            approved = timestamp(approval['approved_at'])
            require(latest is not None and latest <= approved <= now, 'approval must follow evidence and not be in the future')
        except (KeyError, ValueError, TypeError, AttributeError):
            blockers.append('invalid approval timestamp')
    return blockers


def template(candidate, environment, owner):
    return {
        'schema_version': 1, 'candidate_sha256': candidate, 'environment': environment,
        'owner': owner, 'approval': None,
        'checks': [dict(id=name, status='pending', candidate_sha256=candidate,
                        environment=environment, command='', reviewer='', coverage='',
                        completed_at='', evidence=[]) for name in REQUIRED_CHECKS],
    }


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f'duplicate JSON key: {key}')
        result[key] = value
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('init', 'check'))
    parser.add_argument('--packet', required=True, type=Path)
    parser.add_argument('--candidate-sha256', required=True)
    parser.add_argument('--environment', required=True)
    parser.add_argument('--owner', default='')
    args = parser.parse_args(argv)
    if not HEX.fullmatch(args.candidate_sha256) or not args.environment.strip():
        parser.error('a lowercase SHA-256 candidate identity and nonempty environment are required')
    try:
        if args.action == 'init':
            if not args.owner.strip():
                parser.error('--owner is required for init')
            with args.packet.open('x') as output:
                json.dump(template(args.candidate_sha256, args.environment, args.owner), output, indent=2)
                output.write('\n')
            return 0
        packet = json.loads(args.packet.read_text(), object_pairs_hook=unique_object)
        if not isinstance(packet, dict):
            raise ValueError('packet must be an object')
        blockers = validate(packet, args.packet.parent, args.candidate_sha256, args.environment)
    except (OSError, ValueError, TypeError) as error:
        blockers = [str(error)]
    print(json.dumps({'ready': not blockers, 'candidate_sha256': args.candidate_sha256,
                      'environment': args.environment, 'blockers': blockers}, indent=2))
    return 1 if blockers else 0


if __name__ == '__main__':
    sys.exit(main())
