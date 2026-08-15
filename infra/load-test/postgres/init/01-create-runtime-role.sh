#!/usr/bin/env bash
set -euo pipefail

if [[ "${POSTGRES_DB:-}" != "sgs_loadtest" ]]; then
  echo "[loadtest] refusing database initialization outside sgs_loadtest" >&2
  exit 1
fi

if [[ -z "${POSTGRES_APP_PASSWORD:-}" ]]; then
  echo "[loadtest] POSTGRES_APP_PASSWORD is required" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_password="$POSTGRES_APP_PASSWORD" <<'SQL'
SELECT 'CREATE ROLE neondb_owner NOLOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'neondb_owner');
\gexec

SELECT 'CREATE ROLE sgs_admin NOLOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sgs_admin');
\gexec

SELECT format('CREATE ROLE sgs_app LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sgs_app');
\gexec

SELECT format('ALTER ROLE sgs_app LOGIN PASSWORD %L', :'app_password')
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sgs_app');
\gexec

GRANT CONNECT ON DATABASE sgs_loadtest TO sgs_app;
GRANT USAGE ON SCHEMA public TO sgs_app;
SQL
