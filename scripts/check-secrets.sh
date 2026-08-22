#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

failed=0

tracked_env_files="$(git ls-files | awk '/(^|\/)\.env/ && $0 != ".env.example" { print }')"
if [[ -n "$tracked_env_files" ]]; then
  echo "Secret guard: tracked environment files are not allowed:" >&2
  echo "$tracked_env_files" >&2
  failed=1
fi

tracked_data_files="$(git ls-files | awk 'tolower($0) ~ /\.(sqlite|sqlite3|db|dump|backup|bak)$/ { print }')"
if [[ -n "$tracked_data_files" ]]; then
  echo "Secret guard: tracked database/export files are not allowed:" >&2
  echo "$tracked_data_files" >&2
  failed=1
fi

if grep -Eq '^BITRIX24_WEBHOOK_URL=.+$' .env.example; then
  echo "Secret guard: .env.example must not contain a webhook value." >&2
  failed=1
fi

candidate_files=()
while IFS= read -r -d '' file; do
  [[ "$file" == "scripts/check-secrets.sh" ]] && continue
  candidate_files+=("$file")
done < <(git ls-files --cached --others --exclude-standard -z)

if [[ "${#candidate_files[@]}" -gt 0 ]] && grep -nEIH "https?://[^[:space:]\"'<>]+/rest/[0-9]+/[[:alnum:]_-]{8,}/?" "${candidate_files[@]}"; then
  echo "Secret guard: a credential-shaped Bitrix REST webhook may be tracked." >&2
  failed=1
fi

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi

echo "Secret guard passed: no tracked webhook credential, env file, or database export found."
