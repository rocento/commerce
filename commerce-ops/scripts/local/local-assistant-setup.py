"""Initialize local shared AI storage without touching production or replacing volumes."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import json
from datetime import datetime, timezone
import os
from pathlib import Path
import secrets
import subprocess

ROOT = Path(__file__).resolve().parents[3]
os.chdir(ROOT)
SECRET = ROOT / '.local/assistant'
COMPOSE = ['docker', 'compose', '--env-file', '.env', '-p', 'commerce-ai', '-f',
           'commerce-ops/compose/compose.yaml', '-f', 'commerce-ops/compose/compose.assistant.yaml']
DB = 'commerce-ai-ai-postgres-1'


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def sql(database, statement):
    return subprocess.check_output(
        ['docker', 'exec', '-i', DB, 'psql', '-U', 'ai_owner', '-d', database,
         '-v', 'ON_ERROR_STOP=1', '-At'], input=statement, text=True).strip()


def language(*args):
    env = dict(os.environ, DATABASE_URL=operator_url)
    run(['docker', 'run', '--rm', '--network', 'commerce-ai_assistant-private',
         '-e', 'DATABASE_URL', 'rocento-language-engine:release', 'node', *args], env=env)


run(['python3', 'commerce-ops/scripts/local/assistant-setup.py'])
run(COMPOSE + ['up', '-d', '--no-build', '--wait', 'ai-postgres'])
backup = ROOT / '.local' / ('local-ai-backup-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
backup.mkdir(exist_ok=True, mode=0o700)
with (backup / 'assistant.dump.partial').open('wb') as f:
    run(['docker', 'exec', DB, 'pg_dump', '-U', 'ai_owner', '-d', 'assistant', '-Fc'], stdout=f)
(backup / 'assistant.dump.partial').rename(backup / 'assistant.dump')
# Preserve production login-bound policies when refreshing a shared snapshot.
shared = sql('assistant', "SELECT to_regclass('assistant.tenant_logins') IS NOT NULL") == 't'
migrations = '\n'.join(m.read_text() for m in sorted((ROOT / 'commerce-assistant-platform/migrations').glob('*.sql'))
                       if int(m.name[:3]) >= 3)
if shared:
    migrations += '\n' + (ROOT / 'commerce-ops/deploy/assistant/shared-tenants.sql').read_text()
sql('assistant', 'BEGIN;\n' + migrations + '\nCOMMIT;')
password_path = SECRET / 'language-runtime-password'
if not password_path.exists():
    password_path.write_text(secrets.token_hex(32))
    password_path.chmod(0o600)
password = password_path.read_text().strip()
admin_password = (SECRET / 'store-admin-password').read_text().strip()
operator_url = f'postgres://ai_owner:{admin_password}@ai-postgres:5432/commerce_language'
if sql('postgres', "SELECT count(*) FROM pg_database WHERE datname='commerce_language'") == '0':
    sql('postgres', 'CREATE DATABASE commerce_language')
language('scripts/database.ts', 'migrate')
active = sql('commerce_language', "SELECT release_id FROM release.channels WHERE channel='production'")
# Import the packaged verified baseline only for an empty local language database.
if not active:
    language('scripts/release.ts', 'import-baseline', '--bundle', 'data/deployment-release.json.gz', '--expected-active', 'none')
    import gzip
    bundle = json.loads(gzip.decompress((ROOT / 'commerce-assistant-platform/app/commerce_language_engine/data/deployment-release.json.gz').read_bytes()))
    release_id = bundle['payload']['identity']['releaseId']
    language('scripts/release.ts', 'bootstrap', '--release-id', release_id,
             '--actor', 'local-setup', '--reason', 'Initialize local database from packaged verified baseline')
if sql('postgres', "SELECT count(*) FROM pg_roles WHERE rolname='ai_language_runtime'") == '0':
    sql('postgres', 'CREATE ROLE ai_language_runtime NOLOGIN')
if sql('postgres', "SELECT count(*) FROM pg_roles WHERE rolname='language_local'") == '0':
    sql('postgres', 'CREATE ROLE language_local LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE ai_language_runtime')
sql('postgres', "ALTER ROLE language_local PASSWORD '" + password.replace("'", "''") + "'")
sql('commerce_language', (ROOT / 'commerce-ops/deploy/assistant/shared-language-tenants.sql').read_text())
tenant = sql('assistant', 'SELECT tenant_id FROM assistant.deployment WHERE singleton')
import uuid
uuid.UUID(tenant)
sql('commerce_language', f"INSERT INTO context.tenant_logins VALUES ('language_local','{tenant}','local') ON CONFLICT(role_name) DO UPDATE SET tenant_id=excluded.tenant_id")
env_file = SECRET / 'local-compose.env'
assistant_user = 'ai_runtime'
if shared:
    assistant_user = 'ai_runtime_grocery'
    mapped = sql('assistant', "SELECT tenant_id FROM assistant.tenant_logins WHERE role_name='ai_runtime_grocery'")
    if mapped != tenant:
        raise RuntimeError('Local grocery identity does not match the restored shared assistant login')
    runtime_password = (SECRET / 'store-runtime-password').read_text().strip()
    sql('postgres', "ALTER ROLE ai_runtime_grocery LOGIN PASSWORD '" + runtime_password.replace("'", "''") + "'")
env_file.write_text(f'ASSISTANT_TENANT_ID={tenant}\nLOCAL_AI_STORE_USER={assistant_user}\nLOCAL_LANGUAGE_DATABASE_URL=postgres://language_local:{password}@shared-ai-postgres:5432/commerce_language\n')
env_file.chmod(0o600)
print('Local shared AI storage initialized; existing volumes and commerce language database retained.')
