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
# A fresh version needs a few seconds to reach the edge, so a miss is retried
# for about a minute before the deploy is failed.
attempts="${ASSET_SMOKE_ATTEMPTS:-7}"
for attempt in $(seq 1 "$attempts"); do
  failed=0; missing=""
  html="$(curl -fsS --max-time 30 "$base/")" || { failed=1; missing="$base/"; }
  if (( failed == 0 )); then
    mapfile -t assets < <(printf '%s' "$html" | grep -oE '(src|href)="/assets/[^"]+"' | sed -E 's/.*="([^"]+)"/\1/' | sort -u)
    (( ${#assets[@]} )) || { failed=1; missing="no /assets bundle referenced"; }
    for asset in "${assets[@]}"; do
      status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$base$asset")"
      [[ "$status" == "200" ]] || { failed=1; missing="$missing $asset→$status"; }
    done
  fi
  if (( failed == 0 )); then echo "asset smoke: ${#assets[@]} bundles load from $base"; exit 0; fi
  echo "asset smoke: attempt $attempt/$attempts missing:$missing" >&2
  (( attempt < attempts )) && sleep 10
done
echo "asset smoke FAILED: roll back with 'npx wrangler rollback <previous-version> --name <worker>'." >&2
exit 1
