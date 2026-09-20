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

## Later staging application

Do not apply while another D1-heavy operation is running. After the daily quota
is available:

1. confirm the target config names the staging Worker and staging D1;
2. build and run `npm run cf:migrate:remote` against that staging config;
3. inspect the migration result and the four seeded currencies;
4. deploy the same reviewed commit to staging;
5. smoke-test each `/api/finance/*` GET, then create controlled fixtures;
6. reconcile Account balances and per-currency summary totals from those fixtures;
7. only after staging approval repeat migration then deploy for production.

Migration `0007_finance_core.sql` is additive. No CRM resync or Analytics
Backfill is required because no existing analytics table or payload changes.
