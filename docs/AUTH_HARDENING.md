# Auth hardening — response to the independent security audit

Branch `feat/auth-integration`, on top of `3cec03b`. Nothing was deployed, no
remote D1 was touched, no migration was executed, no Sync or Backfill ran.

| Finding | Status | Where |
| --- | --- | --- |
| HIGH 1 — independent Sales permissions | FIXED | `lib/sales-sections.ts`, `lib/sales-http.ts`, `app/api/sales/*` |
| HIGH 2 — logout clears the cookie on every path | FIXED | `lib/auth/logout.ts` |
| HIGH 3 — bounded login throttling | FIXED | `lib/auth/throttle.ts`, `lib/auth/login.ts` |
| MEDIUM 1 — bootstrap leaks operational config | FIXED | `app/api/bootstrap/route.ts`, `app/api/diagnostics/route.ts` |
| MEDIUM 2 — atomic last-active-admin | FIXED | `drizzle/0009_auth_admin_invariant.sql` |
| MEDIUM 3 — first-admin CLI target and secret safety | FIXED | `scripts/bootstrap-admin-lib.ts` |
| MEDIUM 4 — auth fixtures in the production bundle | FIXED | `tests/auth-fixture-adapter.ts`, `tests/production-bundle.test.mjs` |
| LOW — one session-lost path | FIXED | `lib/auth-fetch.ts`, `app/auth/auth-shell.tsx` |

## HIGH 1

`/api/dashboard` (every analytics record to any Sales permission) is deleted.
Each Sales section has its own endpoint guarded by exactly one permission:

| Endpoint | Permission | Returns |
| --- | --- | --- |
| `/api/sales/dashboard` | `dashboard` | KPI numbers, previous-period numbers, trend series; manager rows only if the caller also holds `managers` |
| `/api/sales/managers` | `managers` | manager rows |
| `/api/sales/manager` | `managers` | one manager's profile aggregates |
| `/api/sales/lead-flow` | `leadFlow` | heatmap cells and signals |
| `/api/sales/quality` | `quality` | quality analytics |
| `/api/sales/deals` | `deals` | Deal rows, projected to the fields the report shows |
| `/api/current-stages`, `/api/stage-funnel` | `stages` | unchanged |

The calculations run on the server with the same functions the browser used,
over the same populations built by the same predicate; a test reproduces the
old browser pipeline and asserts identical numbers. The metric objects are
stripped of the record arrays `buildDashboardMetrics` also returns.

Filters that would let one section answer another's question are refused with
403 `FILTER_FORBIDDEN`: the Manager filter needs `managers`, Deal search needs
`deals`. Custom Pages compute SALES_KPI widgets on the server and only for a
caller who also holds `dashboard`.

Trade-off: each section request parses the record set in the Worker (the old
route concatenated JSON without parsing). That CPU is the price of never
sending the records to the browser.

## HIGH 2

Every logout response — success, cross-site rejection, no cookie, D1 failure —
carries the clearing `Set-Cookie`. A failed revocation returns 500 with
`revoked: false`, and the UI says the browser is out but the server session
may not be.

## HIGH 3

Two bucket kinds only: `ip:<n>` (hash of the IPv4 address or IPv6 /64, mod
4096) and `user:<id>` for accounts that exist. Unknown emails write nothing
new; raw addresses and emails are never stored. A blocked IP bucket gets 429
before any PBKDF2; a blocked account is answered like a wrong password, with
the equal-cost dummy check. Expired rows are swept at most 50 per write.

Limits: 20 failures / 15 min per IP bucket (15-min block), 10 per account
(10-min block). An account can still be locked for 10 minutes by someone who
knows its email — the usual lockout trade-off, bounded by the IP limit.

## MEDIUM 1

`/api/bootstrap` returns `{}` to any caller without `settings`, and reads
nothing for them. Diagnostics has its own aggregate-only endpoint; Stage
Control gets funnel names and stage semantics with its own data.

## MEDIUM 2

Two triggers abort any UPDATE or DELETE that would leave no active ADMIN.
Tested against real SQLite, including two connections that both read "two
admins" before either wrote. The JavaScript count check is removed.
Migration `0009` is additive (triggers only).

## MEDIUM 3

The config is parsed (JSONC); the named binding must appear exactly once and
its `database_name` and `database_id` must both match what was typed. The
password hash travels in a `0600` file inside a fresh `0700` directory,
passed with `--file`, removed in `finally`. Existing users are detected
before a password is asked for.

## MEDIUM 4

Fixture identities and the fixture adapter now live under `tests/`. After the
build, a test scans the client assets and the server bundle for every fixture
email, name and id.

## LOW

`authFetch` is the one authenticated request path (Sales sections, Finance,
Projects, Pages, Settings, Stage Control, Diagnostics); the auth adapter
reports the same way for Users. 401 → the shell unmounts the app and shows
login, once. 403 → forbidden state, plus one `/api/auth/me` re-read per view
and permission set so changed permissions re-resolve the allowed views. 5xx and
network errors → error, never a sign-out.

## Residuals for the re-audit

- Aggregate probing: with `dashboard`, narrow filters (one day, one source,
  one stage) can isolate small groups of Deals. No Deal identity is returned,
  but tiny aggregates are inherent to a filterable dashboard.
- `stages` still returns Deal-level live rows (Stage Control lists overdue
  Deals by design).
- Account lockout by a known email, as above.
- Manual browser smoke has not been run in this environment.
