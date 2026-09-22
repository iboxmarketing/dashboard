# Auth Security Adversarial Pack v3

Release candidate under test: `de9250990c8571ebfbe328635f8cb7637a95f7ad`

Original V2 pack: `3e0c89779c1a1d77150a935f0b6e7de50200814d`

Audit branch: `audit/auth-security-v3`

This is a test-harness-only semantic port. Runtime code, migrations, deployed
state, and D1 data are unchanged. The V2 status codes, permission boundaries,
parallel-attempt limits, fail-closed share behavior, storage-shape equivalence,
IPv6 equivalence, and fixed safe-error expectations remain intact.

## V2 to V3 mapping

| V2 scenario | Old interface/helper | Current interface/helper | Security expectation |
| --- | --- | --- | --- |
| A1 pages-only cannot add/update Sales widgets | `share-access.canAccessWidgetSources` | `widget-permissions.canUseWidget`; stored-type route check | `pages` never grants Sales data; create/update refuse with 403 before a write |
| A2 pages-only cannot add Projects widgets | `canAccessWidgetSources` | `canUseWidget` and `SOURCE_PERMISSION` | Every Projects-backed widget requires `projects` |
| A3 restricted widgets cannot be published | `canAccessWidgetSources` in share route | `allowedWidgets` plus persisted `ownerUserId` | Share create/update return 403 for a selected source the grantor cannot read |
| A4 permission revocation disables an existing share | direct policy check and route source inspection | `loadUserAccess` → `publicShareWidgetIds` → `shareDataNeeds` | Current grantor access is re-read before any restricted dataset loads |
| A5 later widget-type change fails closed | `canAccessWidgetSources` on current type | `publicShareWidgetIds` on current persisted widget | A formerly manual/allowed widget cannot retain access after becoming Sales/Projects-backed |
| A6 template laundering is refused | route inspection for `canAccessWidgetSources` | `canUseWidget` over the complete template | Authorization happens before `createPage` or any widget write |
| B0 colliding counter transitions | `recordFailure`; `ThrottleRow` get/put store | `reserveAttempt`; atomic `ThrottleStore.reserve` | 100 overlapping increments cannot collapse to one and must reach the block threshold |
| B1 genuine parallel login attempts | old `AtomicThrottleStore` adapter; `USER_LIMIT` | production SQL adapter; `ACCOUNT_LIMIT` | No lost update; at most the lower IP/account limit receives PBKDF2; excess attempts are 429 |
| B2 unique-email attack | old raw-email-compatible harness | fixed `ip:`/`acct:` buckets | One network bounds PBKDF2 and refused network attempts create no account rows |
| B3 D1 atomicity and bounded cardinality | expected `reserve`, `IDENTITY_BUCKETS`, `identityBucketKey` | `RESERVE_SQL`, `ACCOUNT_BUCKETS`, `accountBucketKey`, `sqlThrottleStore` | One upsert/returning transition; finite key spaces; no read-then-write counter |
| C known/unknown structural equivalence | `identity`/`ip` operation categories | `acct`/`ip` reservations and identical bounded sweeps | Account existence creates no distinct persistent path or bucket class |
| D1 equivalent IPv6 spellings | `clientNetwork`, `ipBucketKey` | same helpers, current canonical parser | One address and one `/64` bucket for equivalent forms |
| D2 same/different `/64` | `clientNetwork`, `ipBucketKey` | same helpers | Same `/64` collides; different `/64` does not |
| D3 trusted client IP | `security.clientAddress` | login-specific `throttle.throttleAddress` | `CF-Connecting-IP` wins and login never trusts `X-Forwarded-For` as a fallback |
| E Sync/Backfill safe errors | `safeInternalErrorMessage` | `safeOperationMessage` with `SYNC_FAILED_MESSAGE` / `BACKFILL_FAILED_MESSAGE` | Forced SQL, `password_hash`, and webhook/token-shaped errors remain absent from 500 responses |
| F previous high findings | presence checks for prior suites | direct current helpers, SQLite invariant, integration server, and retained bundle scan | Logout clears on D1 failure; global 401 only; 403 stays signed in; last admin survives; bootstrap is target/secret safe; fixtures stay out of bundles; direct MEMBER APIs enforce permissions |

## Commands

```sh
npm run test:auth-adversarial-v3
npm run verify
```

## Scenario accounting

- Original V2 scenarios: 16
- Ported scenarios: 16
- Passed: 16
- Failed: 0
- A scenario is counted by its preserved top-level V2 identifier/name. The
  bundled F scenario continues to exercise every prior finding listed above.

## Verification result

Audited on 2026-09-22:

- `npm run test:auth-adversarial-v3`: 16 passed, 0 failed.
- `npm run verify`: passed.
  - Sync recovery: 15 passed, 0 failed.
  - Main suite: 875 passed, 0 failed, 1 skipped.
  - Production build and post-build checks: passed, including the fixture
    identity scan of both client and server bundles.
- Lint reported two existing warnings in `lib/stale-resolution.ts` and
  `lib/sync-schedule.ts`; it reported zero errors.
- No production code or migration changed. No deployment or D1 operation was
  performed.
