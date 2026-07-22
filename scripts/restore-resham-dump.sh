#!/usr/bin/env bash

set -euo pipefail

dump_path="${1:-data/resham_dump (1).dump}"
db_name="${2:-resham_clone}"
db_user="${3:-postgres}"
container_name="${4:-bareeze-postgres}"

if [[ ! -f "$dump_path" ]]; then
  echo "Dump file not found: $dump_path" >&2
  exit 1
fi

docker compose -f docker-compose.postgres.yml up -d postgres

until docker compose -f docker-compose.postgres.yml exec -T postgres pg_isready -U "$db_user" >/dev/null 2>&1; do
  sleep 2
done

docker compose -f docker-compose.postgres.yml exec -T postgres psql -U "$db_user" -d postgres -c "DROP DATABASE IF EXISTS \"$db_name\";"
docker compose -f docker-compose.postgres.yml exec -T postgres psql -U "$db_user" -d postgres -c "CREATE DATABASE \"$db_name\";"

docker exec -i "$container_name" pg_restore \
  -U "$db_user" \
  -d "$db_name" \
  --no-owner \
  --no-privileges \
  "/data/$(basename "$dump_path")"

echo
echo "Restore complete."
echo "Database: $db_name"
echo "User: $db_user"
echo "Host: localhost"
echo "Port: 5432"
