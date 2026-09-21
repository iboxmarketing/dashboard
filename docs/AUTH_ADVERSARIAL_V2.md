# Auth Security Adversarial Pack v2

Baseline under test: `2237f80921f2d791921ba85006b34477e013aac4`

Audit branch: `audit/auth-security-v2`

This pack contains regression tests only. It deliberately does not fix the
application. The same expectations must be run unchanged on the hardened
descendant.

## Baseline result

Command:

```sh
npm run test:auth-adversarial-v2
```

At the audited commit, 12 of 16 tests fail and 4 pass.

| Area | Baseline evidence |
| --- | --- |
| Public-share source authorization | A1-A5 fail because there is no shared server-side source authorization policy. |
| Template laundering | A6 fails because `createFromTemplate` writes the page and widgets without checking their source permissions. |
| Atomic login throttle | B0 proves 100 colliding counter transitions collapse to a final count of 1. B1 proves genuine login overlap permits 20 password checks where the identity limit is 10. |
| Unique-email network bound | B2 passes: the existing IP limit bounds password work for this case. B3/C still require a bounded, shape-neutral identity design. |
| Atomic D1 transition | B3 fails because the D1 store has no single-statement reservation operation and the domain uses read-then-write. |
| Account-enumeration storage shape | C fails: a known account performs `user` throttle reads/writes that an unknown account never performs. |
| IPv6 canonicalization | D1 fails: four equivalent spellings produce three network strings instead of one. D2 passes for already-normalized forms. |
| Trusted proxy address | D3 passes: `CF-Connecting-IP` wins over client-controlled `X-Forwarded-For`. |
| Safe operational errors | E fails because the shared safe-error contract is absent; Sync and Backfill must use it rather than return arbitrary exception text. |
| Previous high-finding pack | F passes and asserts that the prior suites and expectations remain enabled. |

## Hardened-code contract

- All page/widget/share/template paths call one source-permission policy.
- Public bearer reads authorize current widget types against the grantor's
  current permissions before loading Sales or Projects data; the share stores
  that grantor identity explicitly.
- Login admission uses an atomic storage reservation. Network and identity
  storage use fixed bucket spaces, and known/unknown failures have the same
  persistent throttle-operation categories.
- IPv6 input is canonicalized before `/64` bucketing.
- Sync and Backfill map arbitrary internal exceptions through a shared safe
  client-error function.
- Existing text-only public shares and all previously accepted security tests
  continue to work.

## Re-audit

After `AUTH_HARDENING_V2_READY_FOR_REAUDIT`, check out the hardened descendant
and run:

```sh
npm run verify
```

Do not edit these expectations to accommodate the implementation. A mismatch
requires review of the implementation or an explicit product/security decision.
