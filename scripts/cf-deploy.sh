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

if [[ "$mode" == "--dry-run" ]]; then
  npx wrangler deploy --dry-run --config wrangler.generated.jsonc
else
  npx wrangler deploy --config wrangler.generated.jsonc
fi
