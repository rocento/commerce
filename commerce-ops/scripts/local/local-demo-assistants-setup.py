"""Connect restored live demo tenants to the existing local shared AI store."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))


import json
import os
import pathlib
import secrets
import subprocess

root = pathlib.Path(__file__).resolve().parents[3]

os.chdir(root)


def run(args, **kw):
    return subprocess.run(args, check=True, **kw)


def out(args):
    return subprocess.check_output(args, text=True)


def sql(db, q):
    return out(
        [
            "docker",
            "exec",
            "commerce-ai-ai-postgres-1",
            "psql",
            "-U",
            "ai_owner",
            "-d",
            db,
            "-Atc",
            q,
        ]
    ).strip()


provider = json.loads(
    out(
        [
            "docker",
            "exec",
            "commerce-ai-ai-service-1",
            "cat",
            "/var/lib/assistant-config/provider.json",
        ]
    )
)
for demo in ["jewelry", "electronics", "pharmacy"]:
    tenant = sql(
        "assistant",
        f"SELECT tenant_id FROM assistant.tenant_logins WHERE role_name='ai_runtime_{demo}'",
    )
    assert tenant == sql(
        "commerce_language",
        f"SELECT tenant_id FROM context.tenant_logins WHERE role_name='language_{demo}'",
    )
    path = root / ".local" / f"assistant-{demo}"
    path.mkdir(exist_ok=True, mode=0o700)
    path.chmod(0o700)
    if not (path / "private.pem").exists():
        run(
            [
                "openssl",
                "genpkey",
                "-algorithm",
                "RSA",
                "-pkeyopt",
                "rsa_keygen_bits:3072",
                "-out",
                str(path / "private.pem"),
            ],
            stderr=subprocess.DEVNULL,
        )
        run(
            [
                "openssl",
                "pkey",
                "-in",
                str(path / "private.pem"),
                "-pubout",
                "-out",
                str(path / "public.pem"),
            ],
            stderr=subprocess.DEVNULL,
        )
    for name in ["private.pem", "public.pem"]:
        (path / name).chmod(0o644)
    for name in ["store-runtime-password", "language-runtime-password"]:
        p = path / name
        if not p.exists():
            p.write_text(secrets.token_hex(32))
        p.chmod(0o644)
    ap = (path / "store-runtime-password").read_text().strip()
    lp = (path / "language-runtime-password").read_text().strip()
    # Passwords use hex only and remain inside subprocess stdin, never printed.
    run(
        [
            "docker",
            "exec",
            "-i",
            "commerce-ai-ai-postgres-1",
            "psql",
            "-U",
            "ai_owner",
            "-d",
            "postgres",
            "-v",
            "ON_ERROR_STOP=1",
        ],
        input=f"ALTER ROLE ai_runtime_{demo} LOGIN PASSWORD '{ap}'; ALTER ROLE language_{demo} LOGIN PASSWORD '{lp}';",
        text=True,
        stdout=subprocess.DEVNULL,
    )
    env = path / "local-compose.env"
    env.write_text(
        f"ASSISTANT_TENANT_ID={tenant}\nASSISTANT_SECRETS_DIR=./.local/assistant-{demo}\nSHARED_AI_STORE_USER=ai_runtime_{demo}\nSHARED_LANGUAGE_DATABASE_URL=postgres://language_{demo}:{lp}@shared-ai-postgres:5432/commerce_language\n"
    )
    env.chmod(0o600)
    # Create consumer networks/volumes without starting services, then attach shared DB.
    run(
        [
            "bash",
            "commerce-ops/scripts/local/local-demo-compose.sh",
            demo,
            "create",
            "--no-build",
            "ai-service",
            "commerce-language-engine",
            "assistant-ingress",
            "assistant-tools",
            "assistant-provider",
        ],
        stdout=subprocess.DEVNULL,
    )
    network = f"commerce-{demo}_assistant-private"
    networks = json.loads(out(["docker", "inspect", "commerce-ai-ai-postgres-1"]))[0][
        "NetworkSettings"
    ]["Networks"]
    if network not in networks:
        run(
            [
                "docker",
                "network",
                "connect",
                "--alias",
                "shared-ai-postgres",
                network,
                "commerce-ai-ai-postgres-1",
            ]
        )
    config = dict(provider, tenant=tenant)
    # Initialize this local tenant from the already working local provider settings.
    run(
        [
            "docker",
            "run",
            "--rm",
            "-i",
            "--user",
            "0",
            "-v",
            f"commerce-{demo}_assistant-config:/config",
            "--entrypoint",
            "python",
            "rocento-ai-service:release",
            "-c",
            "import os,sys,json; p='/config/provider.json'; data=sys.stdin.read(); existing=json.load(open(p)) if os.path.exists(p) else None; assert existing is None or existing.get('tenant')==json.loads(data)['tenant'], 'Existing provider belongs to another tenant'; f=open(p,'w') if existing is None else None; f.write(data) if f else None; f.close() if f else None; os.chmod(p,0o600); os.chown(p,10001,10001)",
        ],
        input=json.dumps(config),
        text=True,
    )
    run(
        [
            "bash",
            "commerce-ops/scripts/local/local-demo-compose.sh",
            demo,
            "up",
            "-d",
            "--no-build",
            "--wait",
            "api-gateway",
            "ai-service",
            "commerce-language-engine",
            "assistant-ingress",
            "assistant-tools",
            "assistant-provider",
        ]
    )
    print(demo, "assistant services started", flush=True)

(root / ".local/assistant/all-demos-enabled").touch()
