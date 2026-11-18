"""Controller-only private GitHub release download and pinned SSH delivery."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import urllib.request


def validate(pin):
    if not isinstance(pin, dict) or set(pin) != {'repository', 'assetId', 'sha256', 'revision', 'inventoryDigest'}:
        raise ValueError('INVALID_RELEASE_PIN')
    for field, pattern in [('repository', r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+'),
                           ('sha256', r'[a-f0-9]{64}'), ('revision', r'[a-f0-9]{40}'),
                           ('inventoryDigest', r'sha256:[a-f0-9]{64}')]:
        if not isinstance(pin[field], str) or not re.fullmatch(pattern, pin[field]):
            raise ValueError('INVALID_RELEASE_PIN')
    if type(pin['assetId']) is not int or pin['assetId'] <= 0:
        raise ValueError('INVALID_RELEASE_PIN')


def checksum(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


class AssetRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, url):
        target = urllib.parse.urlparse(url)
        if target.scheme != 'https' or target.hostname not in {'release-assets.githubusercontent.com', 'objects.githubusercontent.com'}:
            raise ValueError('UNTRUSTED_RELEASE_REDIRECT')
        redirected = super().redirect_request(request, fp, code, msg, headers, url)
        redirected.remove_header('Authorization')
        return redirected


def download(pin, directory, token):
    validate(pin)
    destination = directory / ('release-' + pin['sha256'] + '.tar')
    if destination.exists():
        if destination.is_symlink() or checksum(destination) != pin['sha256']:
            raise ValueError('RELEASE_CACHE_CHANGED')
        return destination
    url = 'https://api.github.com/repos/' + pin['repository'] + '/releases/assets/' + str(pin['assetId'])
    request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token.strip(),
        'Accept': 'application/octet-stream', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'rocento-fleet'})
    fd, name = tempfile.mkstemp(dir=directory, prefix='.release-')
    try:
        with os.fdopen(fd, 'wb') as output, urllib.request.build_opener(AssetRedirect()).open(request, timeout=60) as response:
            shutil.copyfileobj(response, output, 1024 * 1024)
            output.flush()
            os.fsync(output.fileno())
        if checksum(Path(name)) != pin['sha256']:
            raise ValueError('RELEASE_BUNDLE_CHANGED')
        os.replace(name, destination)
    finally:
        if os.path.exists(name):
            os.unlink(name)
    return destination


def transfer(args, bundle, host_id):
    # File-backed stdin avoids buffering multi-GB Docker archives in memory.
    with tempfile.TemporaryFile() as payload:
        payload.write((json.dumps({'operation': 'install-release', 'hostId': host_id}) + '\n').encode())
        with bundle.open('rb') as source:
            shutil.copyfileobj(source, payload, 1024 * 1024)
        payload.seek(0)
        result = subprocess.run(args, stdin=payload, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=900)
    if result.returncode or json.loads(result.stdout) != {'installed': True}:
        raise ValueError('BOOTSTRAP_RECONCILIATION_REQUIRED')
