"""Explicit, reviewed App Studio stage promotion; not full production certification."""
import sys
if __name__ == "__main__" and not sys.flags.isolated:
    raise SystemExit("Run this command with python3 -I")

import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

import stat

# Self-contained executable: invoke with python3 -I from the protected path.
def sha256(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1048576), b''):
            h.update(chunk)
    return h.hexdigest()


def protected(path):
    path = Path(path).absolute()
    for entry in [path, *path.parents]:
        info = entry.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('untrusted authorization path: ' + str(entry))
    if not path.is_file():
        raise ValueError('expected regular authorization file')


def unique_object(pairs):
    value = {}
    for k, v in pairs:
        if k in value:
            raise ValueError('duplicate JSON key')
        value[k] = v
    return value


def timestamp(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('timestamp timezone required')
    return parsed.astimezone(timezone.utc)

ROOT = Path('/opt/rocento')
NGINX = Path('/etc/nginx/sites-available/rocento')
FRONTEND = Path('/var/www/rocento/current')
AUTH = Path('/etc/rocento/release/app-studio-stage.json')
GATEWAY = 'rocento-grocery-api-gateway-1'
EXECUTABLE = Path('/usr/local/lib/rocento/app-studio-stage/app_studio_stage.py')
ACCEPTANCE = {'auth_login', 'tall_cards_save_validate', 'invalid_layout_rejected',
              'folder_crud', 'folder_cycle_rejected', 'test_data_cleaned', 'ingress_rejections'}
MIGRATION = '20261015150000'
CHECKS = {'candidate-runtime', 'banner-schema', 'asset-ownership', 'migration-upgrade',
          'fallback-compatibility', 'security-review', 'activation-review'}
OLD_ROUTE = 'assets(/[0-9a-f-]{36}/content)?'
NEW_ROUTE = 'asset-library|asset-folders(/[0-9a-f-]{36})?|assets(/(move|[0-9a-f-]{36}(/content)?))?'


def require(ok, message):
    if not ok:
        raise ValueError(message)


def run(args, **kwargs):
    return subprocess.check_output(args, text=True, timeout=kwargs.pop('timeout', 120), **kwargs).strip()


def read(path):
    return json.loads(Path(path).read_text(), object_pairs_hook=unique_object)


def keys(value, expected):
    require(isinstance(value, dict) and set(value) == set(expected), 'unexpected or missing fields')


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def tree(path):
    resolved = path.resolve(strict=True)
    files = {}
    for p in sorted(resolved.rglob('*')):
        require(not p.is_symlink(), 'frontend contains symlink')
        if p.is_file():
            files[str(p.relative_to(resolved))] = sha256(p)
    require(files, 'empty frontend')
    return {'path': str(resolved), 'sha256': digest(files)}


def ledger(container):
    sql = "SELECT version::text || '|' || encode(checksum,'hex') || '|' || success::text FROM _sqlx_migrations ORDER BY version"
    rows = run(['docker', 'exec', container, 'sh', '-c',
                'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1"', 'stage', sql])
    result = {}
    for row in rows.splitlines():
        version, checksum, success = row.split('|')
        require(success == 'true', 'unsuccessful database migration')
        result[version] = checksum
    return result


def state():
    names = run(['docker', 'ps', '-a', '--format', '{{.Names}}']).splitlines()
    containers = {}
    for name in sorted(n for n in names if n.startswith('rocento-')):
        info = json.loads(run(['docker', 'inspect', name]))[0]
        containers[name] = {'id': info['Id'], 'image': info['Image']}
    files = set(ROOT.glob('compose*.yaml'))
    for pattern in ('*.yaml', '*.env'):
        files.update((ROOT / 'deploy/ec2').glob(pattern))
    files.add(ROOT / 'deploy/ec2/server/ec2-compose.sh')
    return {'machine': sha256(Path('/etc/machine-id')), 'containers': containers,
            'config': {str(p.relative_to(ROOT)): sha256(p) for p in sorted(files)},
            'ingress': sha256(NGINX), 'frontend': tree(FRONTEND),
            'commerce': ledger('rocento-grocery-postgres-1'),
            'engagement': ledger('rocento-grocery-engagement-postgres-1')}


def packet_file(directory, item):
    keys(item, ('path', 'sha256'))
    p = Path(item['path'])
    require(not p.is_absolute() and '..' not in p.parts and len(p.parts) == 1,
            'packet file must be a direct child')
    result = directory / p
    protected(result)
    require(sha256(result) == item['sha256'], 'packet file checksum mismatch: ' + str(p))
    return result


def image_check(artifact):
    keys(artifact, ('image', 'binaries', 'source'))
    identity = artifact['image']
    require(bool(re.fullmatch(r'sha256:[0-9a-f]{64}', identity)), 'invalid image identity')
    info = json.loads(run(['docker', 'image', 'inspect', identity]))[0]
    require(info['Id'] == identity and info['Architecture'] == 'arm64' and info['Os'] == 'linux', 'image mismatch')
    require(info['Config']['User'] == '10001:10001', 'unexpected runtime user')
    names = {'api-gateway', 'analytics-worker', 'engagement-worker', 'export-worker',
             'seed-admin', 'sync-reports', 'install-catalog-data', 'prepare-storefront-images'}
    require(set(artifact['binaries']) == names, 'incomplete binary inventory')
    actual = run(['docker', 'run', '--rm', '--network', 'none', '--read-only',
                  '--entrypoint', 'sha256sum', identity, *['/usr/local/bin/' + n for n in sorted(names)]])
    hashes = {Path(p).name: h for h, p in (line.split() for line in actual.splitlines())}
    require(hashes == artifact['binaries'], 'image binary mismatch')


def validate_inventory(inv, directory, now):
    keys(inv, ('policy', 'environment', 'store', 'scope', 'prior', 'candidate', 'fallback',
               'commerce', 'engagement', 'ingress', 'acceptance', 'checks', 'deferrals',
               'limitations', 'activation_sha256', 'prior_compose'))
    require(inv['policy'] == 'app-studio-stage-v1' and inv['environment'] == 'apps.rocento.com'
            and inv['store'] == 'grocery', 'unsupported target')
    require(inv['scope'] == ['grocery-api-gateway', 'app-studio-asset-ingress', MIGRATION], 'unsupported scope')
    require(inv['deferrals'] == ['backups', 'disaster-recovery'], 'unexpected user deferrals')
    require(inv['limitations'] == ['not-full-production-readiness', 'capacity-unqualified'], 'limitations missing')
    require(inv['activation_sha256'] == sha256(Path(__file__)), 'activation code differs from review')
    require(set(inv['checks']) == CHECKS, 'focused checks incomplete')
    for name, check in inv['checks'].items():
        keys(check, ('status', 'completed_at', 'coverage', 'evidence', 'candidate_image', 'fallback_image'))
        require(check['candidate_image'] == inv['candidate']['image']
                and check['fallback_image'] == inv['fallback']['image'], name + ' artifact mismatch')
        require(check['status'] == 'passed' and check['coverage'].strip(), name + ' not passed')
        age = (now - timestamp(check['completed_at'])).total_seconds()
        require(0 <= age <= 86400, name + ' stale')
        require(check['evidence'], name + ' missing evidence')
        for item in check['evidence']:
            packet_file(directory, item)
    for name in ('candidate', 'fallback'):
        image_check(inv[name])
        source = read(packet_file(directory, inv[name]['source']))
        require(source['commerce'] == inv['commerce'] and source['engagement'] == inv['engagement'],
                name + ' migration source mismatch')
        require(source.get('gateway_source_sha256') and source.get('base_image'), 'layer provenance missing')
    for binary, checksum in inv['candidate']['binaries'].items():
        if binary != 'api-gateway':
            require(inv['fallback']['binaries'][binary] == checksum, 'fallback changed retained binary')
    pending = set(inv['commerce']) - set(inv['prior']['commerce'])
    require(pending == {MIGRATION}, 'unexpected pending migrations')
    require(len(inv['prior']['commerce']) == 102, 'unexpected supported prior ledger')
    require(all(inv['commerce'].get(v) == h for v, h in inv['prior']['commerce'].items()), 'changed applied migration')
    require(inv['engagement'] == inv['prior']['engagement'], 'engagement migration change')
    before = packet_file(directory, inv['ingress']['before'])
    after = packet_file(directory, inv['ingress']['after'])
    keys(inv['ingress'], ('before', 'after'))
    require(sha256(before) == inv['prior']['ingress'], 'prior ingress mismatch')
    text = before.read_text()
    require(text.count(OLD_ROUTE) == 1 and after.read_text() == text.replace(OLD_ROUTE, NEW_ROUTE),
            'ingress exceeds asset route scope')
    packet_file(directory, inv['acceptance'])
    prior_compose = packet_file(directory, inv['prior_compose'])
    require(sha256(prior_compose) == inv['prior']['config']['deploy/ec2/grocery.yaml'], 'prior compose mismatch')


def authorize(path):
    require(Path(__file__).absolute() == EXECUTABLE, 'use installed protected executable')
    protected(EXECUTABLE)
    protected(path)
    auth = read(path)
    keys(auth, ('schema_version', 'inventory_sha256', 'operator', 'reviewer', 'reviewed_at', 'expires_at'))
    require(auth['schema_version'] == 1 and auth['operator'].strip() and auth['reviewer'].strip()
            and auth['operator'] != auth['reviewer'], 'independent review missing')
    now = datetime.now(timezone.utc)
    reviewed, expires = timestamp(auth['reviewed_at']), timestamp(auth['expires_at'])
    require(reviewed <= now < expires and 0 < (expires-reviewed).total_seconds() <= 86400, 'authorization expired')
    inventory = path.parent / 'app-studio-inventory.json'
    protected(inventory)
    require(sha256(inventory) == auth['inventory_sha256'], 'inventory checksum mismatch')
    inv = read(inventory)
    validate_inventory(inv, path.parent, now)
    require(all(timestamp(c['completed_at']) <= reviewed for c in inv['checks'].values()), 'review predates evidence')
    require(state() == inv['prior'], 'live state drifted since review')
    require(shutil.disk_usage(ROOT).free >= 2 * 1024**3, 'less than 2 GiB activation headroom')
    return inv


def compose(image):
    path = ROOT / 'deploy/ec2/grocery.yaml'
    data = read(path)
    data['services']['api-gateway']['image'] = image
    # Replace a complete configuration atomically; preserve ownership/mode.
    mode = path.stat().st_mode & 0o777
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.stage-')
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(data, f, indent=2)
            f.write('\n')
        os.chmod(name, mode)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)
    run(['bash', str(ROOT / 'deploy/ec2/server/ec2-compose.sh'), 'grocery', 'up', '-d',
         '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', '--wait',
         '--wait-timeout', '180', 'api-gateway'], timeout=240)


def preserved(inv, directory=None, image=None, ingress=None):
    current = state()
    for key in ('machine', 'frontend', 'engagement'):
        require(current[key] == inv['prior'][key], key + ' changed')
    require(set(current['containers']) == set(inv['prior']['containers']), 'container inventory changed')
    for name, value in inv['prior']['containers'].items():
        if name != GATEWAY:
            require(current['containers'].get(name) == value, 'unrelated container changed: ' + name)
    expected = dict(inv['prior']['config'])
    expected.pop('deploy/ec2/grocery.yaml')
    actual = dict(current['config'])
    actual.pop('deploy/ec2/grocery.yaml')
    require(actual == expected, 'unrelated configuration changed')
    require(current['commerce'] == inv['commerce'], 'migration ledger differs')
    if directory is not None:
        expected_compose = read(packet_file(directory, inv['prior_compose']))
        expected_compose['services']['api-gateway']['image'] = image
        require(read(ROOT / 'deploy/ec2/grocery.yaml') == expected_compose, 'gateway compose scope changed')
        require(current['containers'][GATEWAY]['image'] == image, 'wrong gateway image')
        health = run(['docker', 'inspect', GATEWAY, '--format', '{{.State.Health.Status}}'])
        require(health == 'healthy', 'gateway unhealthy')
        require(current['ingress'] == ingress, 'ingress differs')
    return current


def acceptance_result(text):
    result = json.loads(text, object_pairs_hook=unique_object)
    keys(result, ('passed', 'checks', 'details'))
    require(result['passed'] is True and set(result['checks']) == ACCEPTANCE
            and all(v is True for v in result['checks'].values()), 'acceptance failed or incomplete')
    require(isinstance(result['details'], dict), 'invalid acceptance details')
    return result


def recover(inv, directory):
    errors = []
    # Neither recovery branch may prevent the other from being attempted.
    try:
        compose(inv['fallback']['image'])
    except Exception as error:
        errors.append('gateway recovery: ' + str(error))
    try:
        shutil.copyfile(packet_file(directory, inv['ingress']['before']), NGINX)
        run(['nginx', '-t'])
        run(['systemctl', 'reload', 'nginx'])
    except Exception as error:
        errors.append('ingress recovery: ' + str(error))
    try:
        preserved(inv, directory, inv['fallback']['image'], inv['prior']['ingress'])
        run(['curl', '--fail', '--silent', '--max-time', '15', 'http://127.0.0.1:8080/ready'])
    except Exception as error:
        errors.append('recovery verification: ' + str(error))
    require(not errors, '; '.join(errors))


def activate(path):
    with (ROOT / 'deploy/ec2/setup.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        inv = authorize(path)
        directory = path.parent
        before = packet_file(directory, inv['ingress']['before'])
        after = packet_file(directory, inv['ingress']['after'])
        # Candidate syntax validation before replacing any live file/container.
        with tempfile.TemporaryDirectory(prefix='rocento-stage-nginx-') as tmp:
            test = Path(tmp) / 'nginx.conf'
            text = Path('/etc/nginx/nginx.conf').read_text()
            require(text.count('include /etc/nginx/sites-enabled/*;') == 1, 'unexpected nginx main configuration')
            # Keep other sites by making a private copy of the enabled-site directory.
            sites = Path(tmp) / 'sites'
            sites.mkdir()
            for existing in Path('/etc/nginx/sites-enabled').iterdir():
                shutil.copyfile(after if existing.resolve() == NGINX.resolve() else existing, sites / existing.name)
            test.write_text(text.replace('include /etc/nginx/sites-enabled/*;', 'include ' + str(sites) + '/*;'))
            run(['nginx', '-t', '-c', str(test)])
        changed = False
        try:
            changed = True  # Migration may commit even if readiness later fails.
            compose(inv['candidate']['image'])
            shutil.copyfile(after, NGINX)
            run(['nginx', '-t'])
            run(['systemctl', 'reload', 'nginx'])
            current = preserved(inv, directory, inv['candidate']['image'], inv['ingress']['after']['sha256'])
            require(current['containers'][GATEWAY]['image'] == inv['candidate']['image'], 'wrong live gateway')
            require(current['ingress'] == inv['ingress']['after']['sha256'], 'wrong live ingress')
            run(['curl', '--fail', '--silent', '--max-time', '15', 'http://127.0.0.1:8080/ready'])
            acceptance = run(['python3', '-I', str(packet_file(directory, inv['acceptance']))], timeout=300)
            print(json.dumps({'deployed': True, 'policy': inv['policy'], 'acceptance': acceptance_result(acceptance),
                              'candidate': inv['candidate']['image'], 'preserved': preserved(inv, directory, inv['candidate']['image'], inv['ingress']['after']['sha256'])}))
        except Exception:
            if changed:
                recover(inv, directory)
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('snapshot', 'check', 'apply'))
    args = parser.parse_args()
    if args.action == 'snapshot':
        print(json.dumps(state(), sort_keys=True, indent=2))
    elif args.action == 'check':
        authorize(AUTH)
        print('{"authorized":true,"policy":"app-studio-stage-v1"}')
    else:
        activate(AUTH)


if __name__ == '__main__':
    main()
