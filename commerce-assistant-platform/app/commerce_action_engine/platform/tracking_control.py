"""Persistent, installation-scoped capture switch; read once at turn admission."""

import json
import os
import tempfile
from functools import lru_cache
from pathlib import Path

from .settings import Settings


@lru_cache(maxsize=32)
def _read(path: str, modified: int, size: int, tenant: str) -> bool:
    if size > 1024:
        raise ValueError("Invalid tracking settings")
    data = json.loads(Path(path).read_text())
    if data.get("tenant") != tenant or type(data.get("enabled")) is not bool:
        raise ValueError("Invalid tracking settings")
    return bool(data["enabled"])


def status(config: Settings) -> dict[str, object]:
    enabled = config.intent_tracking_enabled
    editable = bool(config.provider_settings_file and enabled)
    source = "deployment"
    if editable:
        path = Path(config.provider_settings_file).with_name("tracking.json")
        try:
            info = path.stat()
            enabled = _read(str(path), info.st_mtime_ns, info.st_size, config.tenant_id)
            source = "saved"
        except FileNotFoundError:
            pass
        except (OSError, ValueError, TypeError, AttributeError):
            # A broken settings file must not unexpectedly turn capture on.
            enabled, source = False, "unavailable"
    return {"enabled": enabled, "editable": editable, "source": source}


def save(config: Settings, enabled: bool) -> dict[str, object]:
    if not config.provider_settings_file or not config.intent_tracking_enabled:
        raise ValueError("Tracking is locked by deployment configuration")
    path = Path(config.provider_settings_file).with_name("tracking.json")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=".tracking-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as handle:
            json.dump({"tenant": config.tenant_id, "enabled": enabled}, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
        _read.cache_clear()
    finally:
        Path(name).unlink(missing_ok=True)
    return status(config)
