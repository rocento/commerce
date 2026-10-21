#!/bin/sh
# Keep mode 0644: the official Postgres entrypoint sources this on noexec host mounts.
set -eu
runtime_password=$(cat /run/secrets/ai-runtime-password)
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 --set=runtime_password="$runtime_password" <<'SQL'
CREATE ROLE ai_runtime LOGIN PASSWORD :'runtime_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
SQL
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 --file=/migrations/001_ai_store.sql
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 --set=tenant_id="$ASSISTANT_TENANT_ID" --file=/migrations/002_deployment_boundary.sql

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 --file=/migrations/003_knowledge.sql

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 --file=/migrations/004_conversations.sql

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 --file=/migrations/005_performance_indexes.sql
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 --file=/migrations/006_request_revisions.sql
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 --file=/migrations/007_compound_plans.sql
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 --file=/migrations/008_assistant_tracking.sql
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 --file=/migrations/009_shopping_clarifications.sql
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 --file=/migrations/010_retire_reserved_documents.sql
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 --file=/migrations/011_domain_evidence.sql
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 --file=/migrations/012_account_deletion.sql
