# Agent instructions

Read `docs/HANDOFF.md`, `docs/BUSINESS_RULES.md`, `docs/ARCHITECTURE.md`, and `docs/OPERATIONS.md` before making behavioral changes.

## Non-negotiable product rules

1. `Not Relevant` is always marketing low quality. A prior SQL/Обработка visit must not reclassify it as a Sales loss.
2. `Закрыто и не реализовано` is a Sales loss, separate from marketing low quality.
3. A deal is won when it reaches payment or moves to the matching brand post-sale funnel.
4. IBOX Sales and IBOX post-sale form one IBOX project. SD Sales and SD post-sale form one SD project.
5. Count each Bitrix deal ID once even when the same card moves between funnels.
6. Current-stage counts must come from a live query of all open deals in selected Sales funnels and must not be limited by `DATE_CREATE`.
7. Historical reports are cohort-based and may use the configured import range. Do not present them as live inventory.
8. Seller attribution for completed sales must remain stable; never silently replace it with a later customer-care or call-center assignee.
9. First processing is the CRM-recorded qualification outcome: entry into the SQL/Обработка or Not Relevant stage. Calls do not stop the processing timer, because call coverage is uneven across sellers. Intermediate stages such as No Answer do not count.
10. Call-center funnels are excluded unless the product owner explicitly changes scope.

## Engineering rules

- Never commit or print `BITRIX24_WEBHOOK_URL` or any real Bitrix `/rest/<user>/<secret>/` URL.
- Keep `.openai/hosting.json` and its D1 binding intact for the existing Site.
- Preserve the existing Vinext/Vite/Cloudflare Worker architecture.
- Add or update tests for every calculation-rule change.
- Run `npm run verify` before handoff.
- Do not rewrite migrations that have already shipped; add a new migration.
- Keep the Sites `origin` remote. Use `github` as the portable backup remote.
- Treat D1 data and Sites secrets as hosted state; they are not present in GitHub.
- Ask for clarification before changing funnel meaning, winner/loss rules, attribution order, date cohort definitions, or currency treatment.

## Change workflow

1. State the exact metric or behavior being changed.
2. Identify whether it is live state, historical cohort, or both.
3. Update the smallest relevant module.
4. Add a regression test with a business-readable name.
5. Run `npm run verify`.
6. Summarize calculation impact and any required resync.

Do not claim a number is accurate only because the UI renders. Reconcile it against Bitrix live state or a controlled fixture.
