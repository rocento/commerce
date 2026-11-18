"""Terraform owns VM creation; native provider APIs only verify live identity.

One remote state key per host. Only a saved, creation-only plan may be applied.
After a crash/timeout we inspect state; we never replay apply automatically.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import signal
import tempfile

from fleet_providers import Provider as CloudReader, ProviderError

MODULES = Path(__file__).resolve().parent / 'merchant-terraform'
RESOURCES = {'aws': 'aws_instance', 'gcp': 'google_compute_instance_from_template', 'hetzner': 'hcloud_server'}


def module_digest(name):
    root = MODULES / name
    return hashlib.sha256(b''.join((filename.encode() + b'\0' + (root / filename).read_bytes())
                                  for filename in ('main.tf.json', '.terraform.lock.hcl'))).hexdigest()


def validate_config(config):
    # A real AWS S3 backend is shared by all providers; no local-state fallback.
    if not isinstance(config, dict):
        raise ValueError('INVALID_TERRAFORM_BACKEND')
    for key, pattern in [('bucket', r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]'),
                         ('region', r'[a-z][a-z0-9-]{1,60}'),
                         ('keyPrefix', r'[a-zA-Z0-9][a-zA-Z0-9/_-]{0,160}')]:
        if not isinstance(config.get(key), str) or not re.fullmatch(pattern, config[key]):
            raise ValueError('INVALID_TERRAFORM_BACKEND')
    if set(config) != {'bucket', 'region', 'keyPrefix'}:
        raise ValueError('INVALID_TERRAFORM_BACKEND')


def write(path, value):
    # Never follow a stale temporary symlink or inherit permissive file modes.
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as out:
            json.dump(value, out, sort_keys=True)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def checksum(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def creation_plan(plan, name):
    expected = RESOURCES[name] + '.merchant'
    changes = plan.get('resource_changes', [])
    if (plan.get('errored') or plan.get('complete') is not True or plan.get('deferred_changes')
            or len(changes) != 1 or changes[0].get('address') != expected
            or changes[0].get('mode') != 'managed'
            or changes[0].get('change', {}).get('actions') != ['create']
            or changes[0].get('change', {}).get('importing')
            or changes[0].get('deposed')
            or plan.get('resource_drift')):
        raise ValueError('TERRAFORM_PLAN_NOT_SINGLE_CREATE')


def run_terraform(args, env, timeout):
    # Killing only Terraform can leave a provider plugin issuing cloud requests.
    # Put the CLI and its plugins in one process group and stop the whole group.
    with subprocess.Popen(args, env=env, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          start_new_session=True) as process:
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate()
            raise
        return subprocess.CompletedProcess(args, process.returncode, stdout, stderr)


class Provider:
    def __init__(self, name, profile, secret_reader, *, terraform, directory, trusted, authorize):
        if name not in RESOURCES:
            raise ValueError('INVALID_PROVIDER')
        validate_config(terraform)
        self.name, self.profile, self.secret = name, profile, secret_reader
        self.backend, self.root, self.trusted = terraform, directory / 'terraform', trusted
        self.authorize = authorize
        self.reader = CloudReader(name, profile, secret_reader)

    def binding(self, host):
        return {'hostId': host['id'], 'provider': self.name, 'profileDigest': host['profile_digest'],
                'releaseDigest': host['release_digest'], 'moduleDigest': module_digest(self.name),
                'backend': dict(self.backend, key=self.backend['keyPrefix'].rstrip('/') + '/' + self.name + '/' + host['id'] + '.tfstate')}

    def command(self, *args, timeout=120):
        # Do not inherit CLI flags/workspace overrides or variables that bypass policy.
        env = {k: v for k, v in os.environ.items() if not k.startswith(('TF_', 'TERRAFORM_', 'HCLOUD_'))}
        env.update(TF_IN_AUTOMATION='1', TF_INPUT='0', TF_WORKSPACE='default')
        if self.name == 'hetzner':
            env['HCLOUD_TOKEN'] = self.secret(self.profile['tokenFile']).strip()
        try:
            result = run_terraform(['terraform', '-chdir=' + str(self.root), *args], env, timeout)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise ProviderError('TERRAFORM_COMMAND_INTERRUPTED', retryable=True, uncertain=True) from error
        if result.returncode:
            # CLI output and plans can contain private cloud-init keys. Never log it.
            raise ProviderError('TERRAFORM_COMMAND_FAILED', retryable=True, uncertain=True)
        return result.stdout

    def workspace(self, host, payload=None):
        expected = self.binding(host)
        marker = self.root / 'binding.json'
        if payload is not None and (self.root / 'apply-intent.json').exists():
            raise ValueError('TERRAFORM_APPLY_ALREADY_ATTEMPTED')
        if payload is not None:
            self.root.mkdir(mode=0o700, exist_ok=True)
        self.trusted(self.root)
        for path in self.root.iterdir():
            if (path.name.endswith(('.tf', '.tf.json', '.tfvars', '.tfvars.json'))
                    and path.name not in ('main.tf.json', 'merchant.auto.tfvars.json')):
                raise ValueError('TERRAFORM_UNEXPECTED_CONFIGURATION')
        if marker.exists():
            if json.loads(self.secret(marker)) != expected:
                raise ValueError('TERRAFORM_BINDING_CHANGED')
        elif payload is None:
            raise ValueError('TERRAFORM_WORKSPACE_MISSING')
        else:
            # Refuse to take ownership of a pre-existing unbound working directory.
            if list(self.root.iterdir()):
                raise ValueError('TERRAFORM_WORKSPACE_UNBOUND')
            write(marker, expected)
        for filename in ('main.tf.json', '.terraform.lock.hcl'):
            content = self.trusted(MODULES / self.name / filename).read_bytes()
            target = self.root / filename
            if target.exists():
                if self.trusted(target).read_bytes() != content:
                    raise ValueError('TERRAFORM_MODULE_CHANGED')
            elif payload is None:
                raise ValueError('TERRAFORM_WORKSPACE_MISSING')
            else:
                with target.open('xb') as out:
                    out.write(content)
                target.chmod(0o600)
        backend = {'bucket': self.backend['bucket'], 'region': self.backend['region'],
                   'key': expected['backend']['key'], 'encrypt': True, 'use_lockfile': True}
        if payload is not None:
            # Keep credentials in the process environment, never in TF variables/state.
            profile = {k: v for k, v in self.profile.items() if k not in ('tokenFile', 'maxHosts')}
            instance_name = host.get('instance_name', '')
            if not re.fullmatch(r'merchent-[a-z0-9][a-z0-9-]{1,38}[a-z0-9]', instance_name):
                raise ValueError('INVALID_INSTANCE_NAME')
            variables = {'host_id': host['id'], 'instance_name': instance_name, 'cloud_init': payload, 'profile': profile}
            for filename, value in [('merchant.auto.tfvars.json', variables), ('backend.json', backend)]:
                target = self.root / filename
                if target.exists() and json.loads(self.secret(target)) != value:
                    raise ValueError('TERRAFORM_INPUT_CHANGED')
                if not target.exists():
                    write(target, value)
            seal = self.root / 'inputs.json'
            digests = {name: checksum(self.trusted(self.root / name))
                       for name in ('merchant.auto.tfvars.json', 'backend.json')}
            if seal.exists() and json.loads(self.secret(seal)) != digests:
                raise ValueError('TERRAFORM_INPUT_CHANGED')
            if not seal.exists():
                write(seal, digests)
        elif json.loads(self.secret(self.root / 'backend.json')) != backend:
            raise ValueError('TERRAFORM_BINDING_CHANGED')
        sealed = json.loads(self.secret(self.root / 'inputs.json'))
        actual = {name: checksum(self.trusted(self.root / name))
                  for name in ('merchant.auto.tfvars.json', 'backend.json')}
        if sealed != actual:
            raise ValueError('TERRAFORM_INPUT_CHANGED')
        self.command('init', '-input=false', '-no-color', '-lockfile=readonly', '-backend-config=backend.json')

    def state_reference(self, host):
        state = json.loads(self.command('show', '-json'))
        root = state.get('values', {}).get('root_module', {})
        resources = root.get('resources', [])
        if not resources and not root.get('child_modules'):
            return None
        if len(resources) != 1 or root.get('child_modules'):
            raise ValueError('TERRAFORM_STATE_SCOPE_MISMATCH')
        resource = resources[0]
        if resource.get('tainted') or resource.get('deposed'):
            raise ValueError('TERRAFORM_STATE_REQUIRES_REVIEW')
        if resource.get('address') != RESOURCES[self.name] + '.merchant' or resource.get('mode') != 'managed':
            raise ValueError('TERRAFORM_STATE_SCOPE_MISMATCH')
        values = resource['values']
        labels = values.get('tags' if self.name == 'aws' else 'labels') or {}
        if labels.get('rocento-host') != host['id']:
            raise ValueError('TERRAFORM_STATE_IDENTITY_MISMATCH')
        ref = values.get('instance_id' if self.name == 'gcp' else 'id')
        if not ref:
            raise ValueError('TERRAFORM_STATE_IDENTITY_MISSING')
        if host.get('provider_reference') and str(ref) != host['provider_reference']:
            raise ValueError('PROVIDER_IDENTITY_CHANGED')
        return str(ref)

    def plan_checksum(self):
        return checksum(self.trusted(self.root / 'create.tfplan'))

    def create(self, host, payload, request_file=None):
        self.workspace(host, payload)
        # A crash after this marker can never result in another automatic apply.
        intent = self.root / 'apply-intent.json'
        if intent.exists():
            raise ValueError('TERRAFORM_APPLY_ALREADY_ATTEMPTED')
        if self.state_reference(host) is not None:
            raise ValueError('TERRAFORM_STATE_ALREADY_EXISTS')
        self.command('plan', '-input=false', '-no-color', '-lock-timeout=30s', '-out=create.tfplan')
        plan_hash = self.plan_checksum()
        creation_plan(json.loads(self.command('show', '-json', 'create.tfplan')), self.name)
        # Planning can take time; recheck eligibility immediately before mutation.
        self.authorize()
        if self.plan_checksum() != plan_hash:
            raise ValueError('TERRAFORM_PLAN_CHANGED')
        write(intent, {'hostId': host['id'], 'planSha256': plan_hash})
        self.command('apply', '-input=false', '-no-color', '-lock-timeout=30s', 'create.tfplan', timeout=900)
        reference = self.state_reference(host)
        if reference is None:
            raise ProviderError('TERRAFORM_STATE_NOT_RECORDED', uncertain=True)
        return {'reference': reference, 'operation': None}

    def discover(self, host):
        self.workspace(host)
        reference = self.state_reference(host)
        if reference is None:
            # Never recreate after an interrupted apply or silently adopt an orphan.
            return None
        variables = json.loads(self.secret(self.root / 'merchant.auto.tfvars.json'))
        instance_name = variables.get('instance_name', 'merchant-' + host['id'])
        return self.reader.discover(dict(host, instance_name=instance_name, provider_reference=reference, provider_operation=None))
