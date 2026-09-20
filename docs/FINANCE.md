# Finance foundation

Finance is an isolated ledger module. It shares the Worker and D1 binding with
the dashboard, but its tables are prefixed `finance_` and neither its storage
nor API imports CRM analytics, Sync, seller attribution, or Sales metrics.

## Money and currencies

Persisted money is a safe integer in minor units. UZS, USD, EUR and KZT are
seeded with ISO-style two-decimal minor units. Inputs to the API use fields such
as `amountMinor`; decimal parsing and display formatting live in
`lib/finance/money.ts`. Cross-currency transfers store both user-entered amounts
and never store or infer an authoritative FX rate.

## Balances and reporting

An Account stores its opening balance, never a mutable current balance. Current
and date-range opening balances are derived from Transactions. A transfer is one
Transaction row: it moves money between Accounts but is excluded from Income,
Expense and operating net cash flow. Every aggregate is partitioned by currency.

Subscriptions are templates only. Creating or updating one never creates a
Transaction.

## UI and API contract

`lib/finance/types.ts` is the persisted/wire domain. The browser keeps those
field names unchanged through `lib/finance-adapter.ts`:

- money is `openingBalanceMinor`, `amountMinor`, `sourceAmountMinor`, and
  `destinationAmountMinor`;
- currency is `currencyCode`, `sourceCurrencyCode`, and
  `destinationCurrencyCode`;
- archive/restore is `archived: boolean`;
- PATCH uses the collection endpoint with `id` in the JSON body;
- create returns `{ id }`, while PATCH returns `{ ok: true }`;
- the Overview reads canonical totals from `/api/finance/summary` and only
  reshapes its per-currency rows for presentation.

Production mode is API-only. Fixture data is available only when a test or
development caller explicitly constructs the adapter with `mode: "fixtures"`.
An API failure is displayed and never replaced by samples.

## Staging smoke checklist

After the reviewed migration and staging deploy:

1. Account: create, edit, archive, restore; confirm current balance stays
   read-only and changes only through Transactions.
2. Transactions: create Income, Expense, same-currency Transfer, and
   cross-currency Transfer; confirm both cross-currency amounts are required.
3. Overview: reconcile Income, Expense, net cash flow, and Account balances per
   currency against the created fixtures; confirm there is no mixed total.
4. Categories: create a parent and matching-kind child; confirm a cross-kind or
   second-level child is rejected visibly.
5. Finance Projects: create one, attach it to a Transaction, and verify the
   selected-range Project summary; confirm management Projects are unchanged.
6. Subscriptions: create upcoming and overdue reminders; confirm no Transaction
   appears automatically.
7. Archive and restore each archivable entity, checking backend errors are
   visible.
8. At desktop and a narrow viewport, open/close every drawer, use keyboard
   focus, change the Finance date range, clear Transaction filters, and retry a
   deliberately failed API request.

## Later staging application

Do not apply while another D1-heavy operation is running. After the daily quota
is available:

1. confirm no Sync, Backfill, or other D1-heavy job is running;
2. export the reviewed staging values for `CLOUDFLARE_WORKER_NAME`,
   `CLOUDFLARE_D1_DATABASE_NAME`, and `CLOUDFLARE_D1_DATABASE_ID`, then run
   `npm run cf:config`;
3. inspect `wrangler.generated.jsonc` and confirm it names only the staging
   Worker and staging D1;
4. apply only the new migration with
   `npx wrangler d1 execute DB --remote --config wrangler.generated.jsonc --file drizzle/0007_finance_core.sql --yes`;
5. query `sqlite_master` and `finance_currencies` through the same reviewed
   config, confirming all six Finance tables plus UZS/USD/EUR/KZT;
6. deploy the reviewed commit with the same staging environment using
   `npm run cf:deploy`;
7. smoke-test each `/api/finance/*` GET, then create controlled fixtures and
   reconcile Account balances and per-currency summary totals;
8. only after staging approval repeat the single-file migration and deployment
   against separately reviewed production identifiers.

Do not use `npm run cf:migrate:remote` on an existing populated database for
this change: the repository helper intentionally walks every historical SQL
file, while staging needs only migration `0007`.

Migration `0007_finance_core.sql` is additive. No CRM resync or Analytics
Backfill is required because no existing analytics table or payload changes.
