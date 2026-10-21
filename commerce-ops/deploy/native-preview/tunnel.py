#!/usr/bin/env python3
"""Connect a gateway-side loopback port to an existing private macOS worker."""
import os
import re

host = os.environ['MOBILE_PREVIEW_SSH_HOST']
user = os.environ['MOBILE_PREVIEW_SSH_USER']
if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', host) or not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_-]*', user):
    raise ValueError('Use a configured SSH alias/hostname and username')
os.execvp('ssh', ['ssh', '-N', '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-L', '127.0.0.1:19095:127.0.0.1:19095', f'{user}@{host}'])
