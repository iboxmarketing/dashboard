#!/usr/bin/env bash
# Post-deploy smoke: the live page and every JS/CSS bundle it references load.
#
# 2026-10-09 a production version shipped without its static assets: the HTML
# rendered "Tekshirilmoqda…" and every /assets/* bundle returned 404, so no
# fresh browser could ever reach the login screen (cached browsers kept
# working, which hid it). This check fails the deploy instead.
#
# Usage: bash scripts/cf-asset-smoke.sh https://<worker>.<subdomain>.workers.dev
set -euo pipefail
base="${1:?usage: cf-asset-smoke.sh <base-url>}"
html="$(curl -fsS --max-time 30 "$base/")" || { echo "asset smoke: $base/ did not load" >&2; exit 1; }
mapfile -t assets < <(printf '%s' "$html" | grep -oE '(src|href)="/assets/[^"]+"' | sed -E 's/.*="([^"]+)"/\1/' | sort -u)
(( ${#assets[@]} )) || { echo "asset smoke: $base/ references no /assets bundle" >&2; exit 1; }
failed=0
for asset in "${assets[@]}"; do
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$base$asset")"
  if [[ "$status" != "200" ]]; then echo "asset smoke: $asset → HTTP $status" >&2; failed=1; fi
done
(( failed == 0 )) || { echo "asset smoke FAILED: roll back with 'npx wrangler rollback <previous-version> --name <worker>'." >&2; exit 1; }
echo "asset smoke: ${#assets[@]} bundles load from $base"
