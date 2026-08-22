# Shared management pages

Read-only public links to a Custom Page. Sprint 21.

## Model

A **share** is a bearer credential pointing at one page, with its own widget
allowlist. One page can back several shares that expose different subsets — a
Board link with Sales KPIs only, an internal link that also carries the notes.

```
custom_pages ──< page_share_tokens ──< page_share_widgets >── custom_page_widgets
```

Migration `0005_page_shares.sql`. Nothing in `0000`–`0004` is altered.

## Token handling

| Stage | What exists |
| --- | --- |
| Create | 256 random bits → base64url (43 chars) — returned once, in the `createShare` response |
| Store | SHA-256 hex in `page_share_tokens.token_hash` (UNIQUE) |
| Open | raw token → SHA-256 → hash lookup |

The raw token is never written to D1, never logged, never echoed into the
rendered page, and cannot be recovered. A lost link means creating a new share.
`listShares` returns a type with no field for a token or a hash.

## Visibility defaults

Selected by default: `SECTION_HEADER`, `SALES_KPI`, `PROJECT_SUMMARY`,
`PROJECT_STATUS_BREAKDOWN`, `MANUAL_KPI`.

**Not** selected by default: `PROJECTS_LIST`, `LATEST_UPDATES`, `TEXT_NOTE` —
these carry internal project names, update text and hand-written prose. The
owner opts in per share.

## Public route

`GET /share/[token]` is a route handler, not a page component:

- route handlers run in the RSC environment, where `react-dom/server` throws at
  runtime, so the HTML is built by `lib/share-render.ts` as a string;
- the response is a complete document with **no JavaScript** — no bundle to
  boot, nothing to hydrate, no RSC payload to audit;
- it can return a real `404` and set its own headers.

Headers: `X-Robots-Tag: noindex, nofollow, noarchive`, `Cache-Control: private,
no-store`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, and a `default-src 'none'` CSP.

Unknown, malformed, revoked, expired, archived-page and internal-error all
return the **same** 404 body, so probing reveals nothing.

Opening a share reads the cached analytics dataset. It never triggers a Bitrix
sync, and it loads only the datasets the allowed widgets actually need.

## Numbers

Shared `SALES_KPI` widgets go through `selectPeriodPopulations` →
`buildDashboardMetrics` → `resolveDashboardMetric`, the same path as the
authenticated dashboard, honouring the page range and any widget override.
There is no second formula. Project widgets reuse the Sprint 19 helpers via
`selectProjectsListRows` / `selectLatestUpdates`, shared with `WidgetBlock`.

## Payload boundary

`lib/share-model.ts` reduces everything to rendered primitives. Widget ids,
`config_json`, deal ids, project ids, settings and analytics records exist on
its input side and on no path out. `tests/page-shares.test.ts` holds the hard
regression test: a page with a PUBLIC KPI, an internal note and an internal
project list, shared with only the KPI, must not emit any of the rest.

## Logging

The token travels in the URL path, so anything that records request URLs
records a live credential.

- **The application logs nothing.** No `console.*` on the share path, no token
  in any error message, and `tests/logging-guard.test.ts` fails the build if
  that changes.
- **Cloudflare Workers observability is disabled** for this Worker
  (`scripts/cf-config.sh`). Its invocation logs capture the full request URL,
  and that capture happens before user code runs — in-Worker redaction cannot
  undo it. Disabling observability is the only fix that does not change the
  share URL format. The cost is no Workers Logs for this Worker at all,
  including the authenticated routes; that trade was made deliberately.
- `Referrer-Policy: no-referrer` keeps the URL out of third-party referrer
  logs, and `Cache-Control: private, no-store` keeps it out of shared caches.

### Accepted limitations

Anything holding the URL holds the credential. That includes the recipient's
**browser history**, their address bar, a screenshot, and any chat or mail
thread the link is pasted into. This is inherent to bearer links and is
accepted for this release.

Closing it means moving the token out of the path — a fragment plus a
JS-performed exchange for a short-lived cookie, or a one-time link that trades
itself for a session. That also re-enables Workers observability. It is a
future enhancement, not a fix applied here.

`wrangler tail` is a separate live-streaming mechanism from retained Workers
Logs; see the Sprint 21.1 report for what disabling observability does and does
not change about it.

## Not covered yet

Rate limiting. An in-memory counter on Workers is not durable and would be
security theater; real throttling needs a Cloudflare WAF rule or a Durable
Object. See the sprint report.
