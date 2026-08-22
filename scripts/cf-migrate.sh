#!/usr/bin/env bash
# Applies the shipped drizzle migrations to a Cloudflare D1 database, in order.
#
#   bash scripts/cf-migrate.sh --local     # miniflare D1, no account needed
#   bash scripts/cf-migrate.sh --remote    # the D1 named in wrangler.generated.jsonc
#
# Migrations are additive and use CREATE TABLE, so re-running against a
# populated database is refused by SQLite rather than silently destructive.
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

target="${1:---local}"
config="${project_root}/wrangler.generated.jsonc"
[[ -f "$config" ]] || { echo "Run scripts/cf-config.sh first (missing ${config})." >&2; exit 69; }

shopt -s nullglob
migrations=(drizzle/*.sql)
(( ${#migrations[@]} )) || { echo "No migrations found in drizzle/." >&2; exit 69; }

for file in "${migrations[@]}"; do
  echo "==> applying ${file} (${target})"
  npx wrangler d1 execute DB "${target}" --config "$config" --file "$file" --yes
done

echo "==> tables present:"
npx wrangler d1 execute DB "${target}" --config "$config" --yes \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"
