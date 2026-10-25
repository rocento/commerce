"""Workstation target parsing for the public ops dispatcher.

Reads named configuration only; never runs shell input or contacts a host.
Provider launcher loaders retain their own direct-invocation contracts.
"""

import argparse
import ipaddress
import os
from pathlib import Path
import re

TARGET_NAME = re.compile(r"[a-z][a-z0-9-]*\Z")
HOST_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9.-]*\Z")
TARGET_FIELDS = {"PROVIDER", "HOST", "SSH_USER", "SSH_KEY", "PROJECT", "ZONE", "INSTANCE"}


class TargetError(ValueError):
    """An operator-facing target configuration error."""


def read_target_file(path: Path, allowed: set[str]) -> dict[str, str]:
    if path.is_symlink() or not path.is_file():
        raise TargetError(f"target file is missing or is a symlink: {path}")
    result = {}
    for number, raw in enumerate(path.read_text().splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise TargetError(f"{path}:{number}: use KEY=value")
        key, value = line.split("=", 1)
        if key not in allowed or key in result or not value or value != value.strip():
            raise TargetError(f"{path}:{number}: unknown, duplicate, or invalid target field {key}")
        result[key] = value
    return result


def resolve_target(args: argparse.Namespace, root: Path) -> dict[str, str]:
    name = args.target
    if not TARGET_NAME.fullmatch(name):
        raise TargetError("--target must be a lowercase name using letters, digits, and hyphens")
    named = root / ".local/commerce-ops/targets" / f"{name}.env"
    if named.exists() or named.is_symlink():
        fields = read_target_file(named, TARGET_FIELDS)
        provider = fields.get("PROVIDER")
        if provider not in ("aws", "gcp"):
            raise TargetError(f"{named}: PROVIDER must be aws or gcp")
        origin = str(named.relative_to(root))
    else:
        provider = {"production-aws": "aws", "production-gcp": "gcp"}.get(name)
        if provider is None:
            raise TargetError(f"create {named} with PROVIDER=aws or PROVIDER=gcp")
        fields = {}
        origin = "scoped environment or command options"

    if fields.get("SSH_USER", "ubuntu") != "ubuntu":
        raise TargetError("the current host commands require SSH_USER=ubuntu")
    if provider == "aws" and any(key in fields for key in ("SSH_KEY", "PROJECT", "ZONE", "INSTANCE")):
        raise TargetError("AWS targets currently accept HOST only; the key stays at .local/commerce-ops/secrets/aws/rocento.pem")
    environment_host = os.environ.get("ROCENTO_AWS_HOST" if provider == "aws" else "GCLOUD_HOST", "")
    host = args.host or environment_host or fields.get("HOST", "")
    if not host or not HOST_NAME.fullmatch(host) or ".." in host or host.endswith("."):
        raise TargetError("set a valid HOST in the named target, scoped environment, or --host")
    if provider == "gcp":
        try:
            ipaddress.IPv4Address(host)
        except ipaddress.AddressValueError as error:
            raise TargetError("GCP requires the VM's direct-origin IPv4 address") from error
    if provider == "aws":
        key = root / ".local/commerce-ops/secrets/aws/rocento.pem"
    else:
        key_text = os.environ.get("GCLOUD_SSH_KEY") or fields.get("SSH_KEY", "")
        key = Path(key_text).expanduser() if key_text else None
        if key is not None and not key.is_absolute():
            key = root / key
    return {"name": name, "provider": provider, "host": host, "user": "ubuntu",
            "key": str(key) if key is not None else "", "origin": origin,
            "project": os.environ.get("GCLOUD_PROJECT") or fields.get("PROJECT", ""),
            "zone": os.environ.get("GCLOUD_ZONE") or fields.get("ZONE", ""),
            "instance": os.environ.get("GCLOUD_INSTANCE") or fields.get("INSTANCE", "")}
