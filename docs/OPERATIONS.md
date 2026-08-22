# Operations and continuity

## Normal production workflow

1. Create a short-lived branch in the private GitHub repository.
2. Make the smallest change that satisfies the metric requirement.
3. Add or update regression tests.
4. Run `npm run verify`.
5. Open a pull request and document whether a resync is required.
6. Merge only after the calculation semantics are reviewed.
7. From the Site owner/editor account, reopen the existing ChatGPT Site and checkpoint the approved commit.
8. Verify the Sites deployment status and then compare one representative number with Bitrix.

## Git remotes

Preserve both remotes:

```text
origin  → ChatGPT Sites internal source repository
github  → private portable backup/collaboration repository
```

Typical synchronization:

```bash
git fetch origin
git fetch github
git push github main
```

Do not force-push `main`. Use a pull request for changes created outside the Site checkout.

## If the current ChatGPT account reaches its work limit

- The live deployment and D1 state remain separate from the coding session.
- Continue code work through GitHub with Claude, another AI tool or an engineer.
- Keep changes in a pull request; do not invent production values for testing.
- When the owner account is available again, fetch/merge the reviewed commit and publish it to the existing Site.
- If eligible, the owner may use additional Codex credits rather than moving the deployment.

## If a second personal ChatGPT account must take over immediately

A GitHub repository transfers source, not ownership of the existing ChatGPT Site.

1. Create a new Site from the repository.
2. Let the new Sites workflow create its own `.openai/hosting.json` identity. Never invent or reuse an opaque project ID across accounts.
3. Configure a new server-side `BITRIX24_WEBHOOK_URL` secret.
4. Apply the D1 migrations.
5. Select the IBOX Sales and matching post-sale funnels in Settings.
6. Run a fresh full sync for the required history window.
7. Validate current stage reconciliation and core business-rule fixtures.
8. Only then switch users to the replacement URL.

The original URL can be updated only by its Site owner or an authorized editor in the same supported workspace.

## Claude or another coding agent

Give the agent repository access, not the production webhook. Its first instruction should be:

> Read `CLAUDE.md`, `AGENTS.md` and all files in `docs/` before changing code. Preserve the business rules and run `npm run verify`.

The agent may prepare pull requests. It cannot manage the original ChatGPT Site unless it operates through an authorized Site owner/editor workflow.

## Secrets

Only one application secret is currently required:

```text
BITRIX24_WEBHOOK_URL
```

Rules:

- store production value only in ChatGPT Sites runtime secrets;
- use ignored `.env.local` for local development;
- never commit `.env.local`, `.dev.vars`, webhook screenshots or database dumps;
- rotate the Bitrix incoming webhook immediately if a real URL reaches GitHub, an AI prompt or logs;
- run `npm run secrets:check` before pushing.

## Database and recovery

GitHub stores migrations, not D1 rows. Most analytics data is recoverable from Bitrix with a full selected-funnel sync. Settings must be re-entered on a new database:

- selected Sales and post-sale funnels;
- SQL stage(s);
- failure reason field;
- Marketing channel field;
- Sales manager field when used;
- stage limits, work schedule, holidays and SLA;
- routing patterns and telephony provider rules.

Capture these values in an internal password manager/runbook, never in a public or AI-readable repository.

## Release checklist

- [ ] PR explains numerator, denominator and date basis.
- [ ] Live vs historical semantics are labeled correctly.
- [ ] Business-rule test added/updated.
- [ ] `npm run verify` passes.
- [ ] No secret or production data is tracked.
- [ ] Migration is additive and reviewed, if present.
- [ ] Resync requirement is stated.
- [ ] Site deployment reaches `succeeded`.
- [ ] One Bitrix number is manually reconciled after deploy.
