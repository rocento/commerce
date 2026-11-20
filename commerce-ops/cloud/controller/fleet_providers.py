"""Bounded provider APIs. An uncertain create is reconciled, never repeated."""
import json
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request


class ProviderError(Exception):
    def __init__(self, code, *, retryable=False, uncertain=False):
        super().__init__(code)
        self.retryable, self.uncertain = retryable, uncertain


def command(args):
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=40, check=False)
    except (subprocess.TimeoutExpired, OSError) as error:
        raise ProviderError('PROVIDER_TRANSPORT_FAILED', retryable=True, uncertain=True) from error
    if result.returncode:
        # Retain only recognized codes, never SDK output containing private data.
        denied = re.search(rb'\b(UnauthorizedOperation|AuthFailure|InvalidParameterValue|InvalidParameterCombination|InvalidAMIID.NotFound|InsufficientInstanceCapacity|InstanceLimitExceeded)\b', result.stderr)
        if denied:
            raise ProviderError('PROVIDER_REQUEST_REJECTED')
        raise ProviderError('PROVIDER_COMMAND_FAILED', retryable=True, uncertain=True)
    return result.stdout


def http(method, url, token, body=None, timeout=20):
    request = urllib.request.Request(url, method=method,
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
        data=None if body is None else json.dumps(body).encode())
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=timeout) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
            if len(raw) > 2 * 1024 * 1024:
                raise ValueError('PROVIDER_RESPONSE_TOO_LARGE')
            return json.loads(raw)
    except urllib.error.HTTPError as error:
        error.close()
        transient = error.code in (408, 429) or error.code >= 500
        raise ProviderError('PROVIDER_HTTP_' + str(error.code), retryable=transient,
                            uncertain=method != 'GET' and (transient or error.code == 409)) from error
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        raise ProviderError('PROVIDER_TRANSPORT_FAILED', retryable=True, uncertain=method != 'GET') from error


class Provider:
    def __init__(self, name, config, secret_reader):
        if name not in ('aws', 'gcp', 'hetzner'):
            raise ValueError('INVALID_PROVIDER')
        self.name, self.config, self.secret = name, config, secret_reader

    def aws(self, *args):
        return json.loads(command(['aws', 'ec2', *args, '--region', self.config['region'],
                                   '--output', 'json', '--no-cli-pager', '--no-paginate']))

    def google(self, method, suffix, body=None):
        token = command(['gcloud', 'auth', 'print-access-token', '--quiet']).decode().strip()
        c = self.config
        base = 'https://compute.googleapis.com/compute/v1/projects/' + urllib.parse.quote(c['project'], safe='')
        base += '/zones/' + urllib.parse.quote(c['zone'], safe='')
        return http(method, base + suffix, token, body)

    def hetzner(self, method, suffix, body=None):
        return http(method, 'https://api.hetzner.cloud/v1' + suffix,
                    self.secret(self.config['tokenFile']).strip(), body)

    def operation_pending(self, host):
        operation = host.get('provider_operation')
        if not operation:
            return False, host.get('provider_reference')
        if self.name == 'gcp':
            result = self.google('GET', '/operations/' + urllib.parse.quote(operation, safe=''))
            if result.get('error'):
                raise ProviderError('PROVIDER_CREATE_FAILED')
            if result.get('targetId') and host.get('provider_reference') and str(result['targetId']) != host['provider_reference']:
                raise ValueError('PROVIDER_IDENTITY_CHANGED')
            return result['status'] != 'DONE', str(result['targetId']) if result.get('targetId') else host.get('provider_reference')
        if self.name == 'hetzner':
            ref = urllib.parse.quote(host['provider_reference'], safe='')
            result = self.hetzner('GET', '/servers/' + ref + '/actions/' + urllib.parse.quote(operation, safe=''))['action']
            if result['status'] == 'error':
                raise ProviderError('PROVIDER_CREATE_FAILED')
            return result['status'] != 'success', host.get('provider_reference')
        return False, host.get('provider_reference')

    def discover(self, host):
        """Enumerate all matching pages before trusting a unique allocation."""
        pending, expected_reference = self.operation_pending(host)
        if pending:
            return None
        found, token, seen = [], None, set()
        for _ in range(20):
            if self.name == 'aws':
                args = ['describe-instances', '--filters', 'Name=tag:rocento-host,Values=' + host['id']]
                if token:
                    args += ['--next-token', str(token)]
                response = self.aws(*args)
                found.extend(i for r in response['Reservations'] for i in r['Instances'])
                token = response.get('NextToken')
            elif self.name == 'gcp':
                path = '/instances?filter=' + urllib.parse.quote('labels.rocento-host=' + host['id'])
                if token:
                    path += '&pageToken=' + urllib.parse.quote(str(token), safe='')
                response = self.google('GET', path)
                found.extend(response.get('items', []))
                token = response.get('nextPageToken')
            else:
                response = self.hetzner('GET', '/servers?label_selector=rocento-host%3D' + host['id'] + '&per_page=50&page=' + str(token or 1))
                found.extend(response['servers'])
                token = response.get('meta', {}).get('pagination', {}).get('next_page')
            if not token:
                break
            if str(token) in seen:
                raise ValueError('PROVIDER_PAGINATION_INVALID')
            seen.add(str(token))
        else:
            raise ValueError('PROVIDER_PAGINATION_LIMIT')
        if len(found) > 1:
            raise ValueError('DUPLICATE_PROVIDER_ALLOCATION')
        if not found:
            return None
        item = found[0]
        if self.name == 'aws':
            reference, status, address = item['InstanceId'], item['State']['Name'], item.get('PublicIpAddress')
            labels = {t['Key']: t['Value'] for t in item.get('Tags', [])}
            if labels.get('rocento-host') != host['id']:
                raise ValueError('PROVIDER_IDENTITY_CHANGED')
            dead, running = status in ('terminated', 'shutting-down'), status == 'running'
        else:
            reference, status = str(item['id']), item['status']
            if item['name'] != host.get('instance_name', 'merchant-' + host['id']) or item.get('labels', {}).get('rocento-host') != host['id']:
                raise ValueError('PROVIDER_IDENTITY_CHANGED')
            if self.name == 'gcp':
                address = next((a.get('natIP') for n in item.get('networkInterfaces', [])
                                 for a in n.get('accessConfigs', []) if a.get('natIP')), None)
                dead, running = status in ('TERMINATED', 'SUSPENDED'), status == 'RUNNING'
            else:
                address = (item.get('public_net', {}).get('ipv4') or {}).get('ip')
                dead, running = status in ('deleting', 'off'), status == 'running'
        if expected_reference and reference != expected_reference:
            raise ValueError('PROVIDER_IDENTITY_CHANGED')
        if dead:
            raise ProviderError('PROVIDER_INSTANCE_STOPPED')
        return {'reference': reference, 'address': address, 'running': running}
