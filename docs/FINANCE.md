# Finance foundation

Finance is an isolated ledger module. It shares the Worker and D1 binding with
the dashboard, but its tables are prefixed `finance_` and neither its storage
nor API imports CRM analytics, Sync, seller attribution, or Sales metrics.

## Money and currencies

Persisted money is a safe integer in minor units. UZS, USD, EUR and KZT are
seeded with ISO-style two-decimal minor units. Inputs to the API use fields such
as `amountMinor`; decimal parsing and display formatting live in
`lib/finance/money.ts`. The browser consumes the runtime `/api/finance/currencies`
metadata for input precision and display; it does not hardcode a decimal step.
Cross-currency transfers store both user-entered amounts and never store or infer
an authoritative FX rate.

## Transfers, commission and the displayed rate

A transfer is one row with an explicit source and destination amount, plus an
optional commission:

| Field | Meaning |
| --- | --- |
| `sourceAmountMinor` / `sourceCurrencyCode` | what left the sending account, as entered |
| `destinationAmountMinor` / `destinationCurrencyCode` | what the receiving account was credited, as entered |
| `feeAmountMinor` | the commission, **in the source account's currency**. `null` (historical rows) and `0` both mean none. There is deliberately no fee-currency selector. |

**Accounting rule.** The transfer itself is neither Income nor Expense. The
commission **is** an Expense.

```
source account       -(sourceAmountMinor + feeAmountMinor)
destination account  +destinationAmountMinor
expense              feeAmountMinor, in the source currency
```

The commission is never subtracted from the destination amount: what arrived is
what the receiving bank credited, and it is entered as its own number.

The fee is carried on the transfer row, not as a second transaction, and the
summary derives it from that row on every read (`lib/finance/summary.ts`). It
therefore cannot be double-counted by repeated reads, cannot be orphaned from its
transfer, and an edit replaces it exactly once. In reporting it lands under one
deterministic, system-owned bucket — id `system:transfer-fee`, name
**Bank komissiyasi** (`lib/finance/transfer.ts`). That bucket is not a
`finance_categories` row: nobody can rename it, archive it, or select it for an
ordinary expense, and a transfer still carries no Category.

**Safe integers.** Every persisted and derived minor-unit value must stay a safe
integer, including the aggregate `sourceAmountMinor + feeAmountMinor` that actually
leaves the source account. `sumMinor` (`lib/finance/money.ts`) is the canonical
checked sum and returns `null` when any input or the running total leaves the
range: validation uses it to **reject** the request before persistence, both in the
browser draft and in the API. Accumulating paths — account balances, summary
totals, per-currency maps — use the throwing twin `addMinor`, so an
unrepresentable total surfaces as a visible Finance error instead of a number that
quietly lost precision. `transferSettlement` reports no settlement at all for a row
whose total cannot be represented, and the UI then renders nothing rather than a
rounded figure.

**Reading a transfer.** One component renders every transfer surface — the
create/edit preview, the ledger row and Finance history — from the shared
`TRANSFER_LABELS`, so the wording and the arithmetic cannot diverge:

| Label | Value |
| --- | --- |
| `Yuborildi` | `sourceAmountMinor` in the source currency |
| `Qabul qilindi` | `destinationAmountMinor` in the destination currency |
| `Kurs` | the derived rate — **cross-currency only** |
| `Komissiya` | `feeAmountMinor`, or `Komissiya yo‘q` |
| `Manba hisobdan jami yechildi` | `sourceAmountMinor + feeAmountMinor` |

Signed amounts and account names alone are not enough: a saved transfer must read
the same way as the one that was entered.

**Displayed rate.** A rate is never persisted and never fetched from a market.
It is derived, on render, from the two exact amounts and the runtime currency
`minorUnit` metadata, in integer arithmetic (BigInt), and it is display/audit
data only — balances are never reconstructed from it. There is no FX gain/loss
accounting in this MVP. The convention, locked by `tests/finance-transfer.test.ts`:

- a same-currency transfer shows **no rate**;
- when UZS is one side of the pair the rate always reads `1 <foreign> = X UZS`,
  whichever direction the money moved (`1 USD = 12 500 UZS`), because that is how
  a rate is quoted here;
- otherwise it reads `1 <source> = X <destination>` (`1 USD = 0.925 EUR`);
- at most six decimals, trailing zeros trimmed, thousands grouped as everywhere
  else in Finance.

A same-currency transfer must have equal source and destination amounts; the API
rejects anything else, along with a negative or fractional commission, a zero or
negative amount, the same account on both sides, and a Category on a transfer.

## Balances and reporting

An Account stores its opening balance, never a mutable current balance. Current
and date-range opening balances are derived from Transactions. A transfer is one
Transaction row: it moves money between Accounts but is excluded from Income,
Expense and operating net cash flow. Every aggregate is partitioned by currency.

Subscriptions are templates only. Creating or updating one never creates a
Transaction.

Income and Expense Transactions require a Category whose kind matches the
Transaction type. Transfers carry no Category. Category nesting is exactly one
level (root → child), and a child must have the same kind as its root. These
rules are enforced in UI shaping, server storage validation, and D1 protection.

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

Account list rows contain configuration and `openingBalanceMinor` only. Derived
current balances are rendered exclusively from the matching server Summary row;
a missing or malformed Summary balance is displayed as unavailable and is never
replaced with the opening balance.

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
   `npx wrangler d1 execute DB --remote --config wrangler.generated.jsonc --file drizzle/<migration>.sql --yes`;
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

### Migration 0012: transfer commission

`drizzle/0012_transfer_fee.sql` adds one nullable column,
`finance_transactions.fee_amount_minor`. It is additive: no row is rewritten,
nothing is dropped, existing transfers read as fee 0, and no exchange rate is
invented for past transfers. SQLite has no `ADD COLUMN IF NOT EXISTS`, so apply
it exactly once per database, and apply it **before** deploying the release that
writes the column — the previous build ignores the extra column, while the new
build's INSERT requires it.
