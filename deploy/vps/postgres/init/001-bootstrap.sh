#!/usr/bin/env bash
set -Eeuo pipefail
set +x

# Runs only when the official PostgreSQL image initializes a brand-new volume.
# Secrets are supplied by /etc/edgebook/edgebook.env through Compose and are
# never written by this script.

: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${EDGEBOOK_DB_OWNER:?EDGEBOOK_DB_OWNER is required}"
: "${EDGEBOOK_DB_OWNER_PASSWORD:?EDGEBOOK_DB_OWNER_PASSWORD is required}"
: "${EDGEBOOK_APP_USER:?EDGEBOOK_APP_USER is required}"
: "${EDGEBOOK_APP_PASSWORD:?EDGEBOOK_APP_PASSWORD is required}"

valid_identifier='^[a-z_][a-z0-9_]{0,62}$'
for value in "$POSTGRES_DB" "$POSTGRES_USER" "$EDGEBOOK_DB_OWNER" "$EDGEBOOK_APP_USER"; do
  if [[ ! "$value" =~ $valid_identifier ]]; then
    printf 'Refusing unsafe PostgreSQL identifier: %s\n' "$value" >&2
    exit 1
  fi
done

psql --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=db_name="$POSTGRES_DB" \
  --set=db_owner="$EDGEBOOK_DB_OWNER" \
  --set=db_owner_password="$EDGEBOOK_DB_OWNER_PASSWORD" \
  --set=app_user="$EDGEBOOK_APP_USER" \
  --set=app_password="$EDGEBOOK_APP_PASSWORD" <<'SQL'
SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L',
  :'db_owner', :'db_owner_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'db_owner')
\gexec

SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L',
  :'app_user', :'app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user')
\gexec

SELECT format('ALTER DATABASE %I OWNER TO %I', :'db_name', :'db_owner')
\gexec

REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"db_name" TO :"app_user";

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO :"db_owner";
GRANT USAGE ON SCHEMA public TO :"app_user";

CREATE SCHEMA IF NOT EXISTS edgebook AUTHORIZATION :"db_owner";
REVOKE ALL ON SCHEMA edgebook FROM PUBLIC;
GRANT USAGE ON SCHEMA edgebook TO :"app_user";

ALTER DEFAULT PRIVILEGES FOR ROLE :"db_owner" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"db_owner" IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"db_owner" IN SCHEMA edgebook
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"db_owner" IN SCHEMA edgebook
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO :"app_user";

ALTER DATABASE :"db_name" SET timezone TO 'UTC';
SQL

printf 'Edge Book database roles and private schema initialized.\n'
