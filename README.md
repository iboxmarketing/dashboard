# IBOX Bitrix24 Sales Analytics

Internal sales analytics dashboard for the IBOX and Sales Doctor Bitrix24 deal funnels. It combines current pipeline state, historical stage movement, calls, lead quality, manager attribution, sales outcomes, and sync diagnostics.

Production is hosted with ChatGPT Sites. This repository is the portable source of truth for development, review, backup, and handoff to another AI assistant or engineer.

## What the app does

- analyzes only explicitly selected Sales funnels and their matching post-sale funnels;
- treats IBOX Sales + IBOX Обучение/Сопровождение as one IBOX project flow;
- treats SD Sales + SD Обучение/Сопровождение as one SD project flow;
- separates marketing low-quality leads (`Not Relevant`) from qualified leads later lost by Sales;
- records a sale when payment is reached or the deal moves to the matching post-sale funnel;
- calculates processing SLA from entry into the SQL or Not Relevant stage, not from calls;
- preserves the seller attached to a completed sale;
- shows a lightweight live snapshot of all currently open deals in selected Sales funnels;
- compares that live snapshot with the historical analytics cache to expose missing or stale records.

The authoritative calculation rules are documented in [docs/BUSINESS_RULES.md](docs/BUSINESS_RULES.md).

## Stack

- TypeScript, React 19, Next-compatible Vinext runtime
- Cloudflare Worker-compatible ESM output
- Cloudflare D1 + Drizzle migrations
- Bitrix24 REST through one server-side incoming webhook
- ChatGPT Sites production hosting

## Repository map

| Path | Purpose |
| --- | --- |
| `app/dashboard-client.tsx` | Dashboard views, filters, tables and client-side presentation calculations |
| `app/api/` | Server API routes for sync, settings, diagnostics and current stages |
| `lib/analytics.ts` | Canonical analytics-record construction |
| `lib/sales-logic.ts` | Sales status, quality and failure-reason classification |
| `lib/sync.ts` | Chunked, resumable Bitrix synchronization |
| `lib/current-stages.ts` | Lightweight live open-deal snapshot and reconciliation |
| `lib/storage.ts` | D1 persistence and sync state |
| `db/schema.ts` | D1 schema |
| `drizzle/` | Versioned D1 migrations |
| `tests/` | Business rules, pipeline pairing and build smoke tests |
| `docs/` | Handoff, architecture, operations and business rules |

## Local setup

Requirements:

- Node.js `>=22.13.0`
- Linux/WSL with `flock`, `curl`, GNU `timeout`, or a compatible development container

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Add the real Bitrix webhook only to the ignored `.env.local` file:

```dotenv
BITRIX24_WEBHOOK_URL=https://your-portal.bitrix24.com/rest/USER_ID/SECRET/
```

Never commit the value or paste it into an AI prompt. Production secrets are managed in the Site settings, not in GitHub.

## Validation

Run the complete local gate before merging or deploying:

```bash
npm run verify
```

This runs the repository secret guard, ESLint, business-rule tests, and the production build. GitHub Actions runs the same gate on pushes and pull requests.

## Deployment model

The checkout has two distinct concerns:

1. ChatGPT Sites keeps the live Site identity, D1 database and runtime secret.
2. GitHub keeps a portable copy of source, documentation, migrations and history.

Keep the existing Sites remote named `origin`. Add a private GitHub repository as a second remote named `github`:

```bash
git remote add github git@github.com:YOUR_ORG/ibox-bitrix-sales-analytics.git
git push -u github main
```

Do not replace `origin`; ChatGPT Sites checkpoints depend on it.

For the current owner account, reopen the existing Site and checkpoint approved changes. A different personal ChatGPT account can use this repository to create a new Site, but it will receive a new Site identity, database and URL. See [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Important data boundary

GitHub contains no production data and no webhook credential. D1 content, Site access settings and runtime secrets stay with the hosted Site. When creating a replacement Site, configure `BITRIX24_WEBHOOK_URL`, apply the included migrations and perform a fresh selected-funnel sync.

## Handoff

Start with [docs/HANDOFF.md](docs/HANDOFF.md). AI coding tools should also read [AGENTS.md](AGENTS.md); Claude Code is directed to the same rules through [CLAUDE.md](CLAUDE.md).
