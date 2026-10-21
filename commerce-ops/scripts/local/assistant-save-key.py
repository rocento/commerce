"""Save a local provider key without echoing it or putting it in shell history."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import getpass
import os
from pathlib import Path


def main():
    path = Path(__file__).resolve().parents[3] / '.local/assistant/model-api-key'
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise SystemExit('Key file already exists; leaving it unchanged.')
    key = getpass.getpass('Paste OpenAI API key (hidden): ').strip()
    if not key:
        raise SystemExit('No key entered; nothing saved.')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write(key)
    print('Saved key securely to', path)


if __name__ == '__main__':
    main()
