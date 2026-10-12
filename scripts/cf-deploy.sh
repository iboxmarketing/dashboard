#!/usr/bin/env bash
# Standalone Cloudflare Workers deploy: verify -> build -> generate config -> deploy.
#
#   bash scripts/cf-deploy.sh --dry-run    # validate without uploading
#   bash scripts/cf-deploy.sh              # deploy
#
# Credentials come from the environment (CLOUDFLARE_API_TOKEN,
# CLOUDFLARE_ACCOUNT_ID) and are never written to disk by this script.
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

mode="${1:-}"
bash scripts/cf-config.sh
npm run build

# A Worker without its static assets renders a page that can never start.
compgen -G "dist/client/assets/*.js" >/dev/null || { echo "No built client bundles in dist/client/assets — refusing to deploy." >&2; exit 1; }
grep -q '"assets": { "directory": "./dist/client" }' wrangler.generated.jsonc || { echo "Generated config has no assets directory — refusing to deploy." >&2; exit 1; }

if [[ "$mode" == "--dry-run" ]]; then
  npx wrangler deploy --dry-run --config wrangler.generated.jsonc
else
  npx wrangler deploy --config wrangler.generated.jsonc
  worker_name="${CLOUDFLARE_WORKER_NAME:-bitrix-deal-dashboard}"
  bash scripts/cf-asset-smoke.sh "https://${worker_name}.${CLOUDFLARE_WORKERS_SUBDOMAIN:-lively-river-afba}.workers.dev"
fi
