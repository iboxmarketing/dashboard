# Standalone Cloudflare deployment

Target architecture:

```text
GitHub  →  Cloudflare Workers  →  Cloudflare D1  →  Bitrix24 REST
```

This path is independent of ChatGPT Sites. The Sites deployment keeps working
unchanged: `.openai/hosting.json`, `build/sites-vite-plugin.ts` and
`vite.config.ts` are untouched, and the same build output serves both.

## Why no committed wrangler config

Wrangler performs no environment-variable interpolation inside its config file,
so a committed config would have to hard-code the account-scoped D1 id.
`scripts/cf-config.sh` generates `wrangler.generated.jsonc` from environment
variables at deploy time instead; the file is git-ignored.

## One-time Cloudflare setup

```bash
npx wrangler login                       # or export CLOUDFLARE_API_TOKEN
npx wrangler d1 create ibox-dashboard-staging
```

`d1 create` prints the `database_id`. Export the identifiers (never commit them):

```bash
export CLOUDFLARE_D1_DATABASE_NAME=ibox-dashboard-staging
export CLOUDFLARE_D1_DATABASE_ID=<uuid printed above>
export CLOUDFLARE_WORKER_NAME=bitrix-deal-dashboard-staging
```

## Apply the schema

```bash
npm run cf:config
npm run cf:migrate:local     # miniflare D1, offline
npm run cf:migrate:remote    # the Cloudflare D1 named above
```

Migrations in `drizzle/` are additive. `ensureSchema()` also creates every table
with `IF NOT EXISTS` at runtime, so a fresh database self-heals if a migration
is skipped.

## Bitrix secret

The webhook is a Cloudflare secret. It must never be in the repo,
`wrangler.generated.jsonc`, a committed `.env`, or GitHub source.

```bash
npx wrangler secret put BITRIX24_WEBHOOK_URL --config wrangler.generated.jsonc
# paste the URL at the interactive prompt — it is not echoed and not stored on disk
```

Local development keeps using the git-ignored `.env.local`.
Rotate the Bitrix webhook immediately if a real URL ever reaches a log or prompt.

## Deploy

```bash
npm run cf:deploy:dry        # validate config, bindings and assets
npm run cf:deploy            # verify -> build -> deploy
```

The first deploy prints a `*.workers.dev` URL. Visit it, open **Sozlamalar**,
select the Sales funnels and configure the four stage-ID groups before syncing.

## GitHub CI/CD

`.github/workflows/deploy.yml` runs `npm run verify` and then deploys.
It is `workflow_dispatch` only; uncomment the `push: branches: [main]` trigger
after a staging deploy has been validated.

Repository configuration:

| Kind | Name |
| --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit, D1:Edit) |
| Secret | `CLOUDFLARE_ACCOUNT_ID` |
| Secret | `CLOUDFLARE_D1_DATABASE_ID` |
| Variable | `CLOUDFLARE_D1_DATABASE_NAME` |
| Variable | `CLOUDFLARE_WORKER_NAME` |

`BITRIX24_WEBHOOK_URL` is set once with `wrangler secret put`, not through CI.

## Custom domain

Staging runs on `*.workers.dev`. For production, after the Worker is deployed
and the zone is on Cloudflare:

1. Cloudflare dashboard → Workers & Pages → the Worker → **Settings → Domains & Routes**.
2. **Add → Custom Domain**, enter e.g. `dashboard.example.com`.
3. Cloudflare creates the DNS record and issues the certificate automatically.
4. Update `metadataBase` in `app/layout.tsx` to the new origin.

No DNS change is required for staging.

## Production D1

The existing ChatGPT Sites D1 is separate and is not touched by this path.
Moving production data is a distinct, separately approved step — export from the
Sites database and import into the Cloudflare one, or run a fresh full sync per
Sales funnel against the new database.
