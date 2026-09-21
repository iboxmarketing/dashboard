# Dashboard authentication and access control

Authentication uses server-side D1 sessions. The browser receives a 256-bit
random token in a `__Host-ibox_session` cookie; D1 stores only its SHA-256
digest. The cookie is `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, and lasts
12 hours. Revoked, expired, or inactive-user sessions are rejected. `lastSeenAt`
is written at most once every 15 minutes per active session.

Passwords use PBKDF2-HMAC-SHA-512 with a random 128-bit salt, a 512-bit output,
and 100,000 iterations — the maximum the Cloudflare Workers edge accepts (it
rejects higher counts; confirmed live on 2026-09-21, though Node and local
workerd allow more, so tests alone cannot catch it). By OWASP's equivalence,
210k SHA-512 ≈ 600k SHA-256; 100k SHA-512 is the strongest PBKDF2 available
here. Stored verifiers above the edge cap are refused rather than crashing. The encoded verifier stores the algorithm, work factor,
salt, and derived value—not the password. PBKDF2 is implemented by the Web
Crypto API available in Cloudflare Workers. Passwords must be 12–256 characters
and contain an uppercase letter, lowercase letter, and digit.

## First administrator

Apply `drizzle/0008_auth_core.sql` and `drizzle/0009_auth_admin_invariant.sql`
to the intended D1 first. Then, from a secure operator terminal, run:

```sh
npm run auth:bootstrap-admin -- \
  --target staging \
  --config /absolute/path/to/staging.wrangler.jsonc \
  --binding DB \
  --database-name bitrix-dashboard-staging \
  --database-id <the database_id from that config> \
  --email admin@example.com \
  --name "Dashboard Admin"
```

Target safety: the config is parsed (JSONC), and the named binding must appear
exactly once — a binding declared twice is ambiguous and refused. Its
`database_name` and `database_id` must both equal what was typed. Add `--env`
to resolve the binding inside `env.<name>`. Worker and D1 names must match the
target; production also requires `--confirm-production`.

Secrets: the temporary password is read twice from a hidden TTY prompt. The
password hash is never a command argument: the INSERT is written to a file
created `0600` in a fresh `0700` directory, passed with `--file`, and deleted
in `finally`. The command counts `app_users` first and refuses before asking
for a password if any user exists; the INSERT itself is also guarded by
`WHERE NOT EXISTS`, and a final read confirms the created row is ours.

## Last active administrator

`drizzle/0009_auth_admin_invariant.sql` adds triggers that abort any UPDATE or
DELETE which would leave no active ADMIN. The rule lives in the database, not
in a count read by JavaScript, so two concurrent demotions cannot both succeed.

## Login throttling

Every attempt reserves a slot in two buckets BEFORE any password work, each
with one atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING`
(`lib/auth/throttle.ts`). Concurrent requests get distinct, increasing counts,
and a reservation past the limit is refused without running PBKDF2 — 100
parallel failures run at most 20 password checks and leave the counter at its
cap.

- `ip:<n>` — n = hash of the client network mod 4096. The network is the
  numerically canonical IPv4 address, or the IPv6 /64 as four fixed-width
  groups, of the trusted `CF-Connecting-IP` header; `X-Forwarded-For` is never
  used. Equivalent IPv6 spellings share a bucket. 20 attempts / 15 min.
- `acct:<n>` — n = hash of the normalized email mod 4096, for EVERY email,
  known or not. 10 attempts / 15 min.

Known and unknown emails run exactly the same storage operations and one
PBKDF2 each. No raw address and no email is stored; the table holds at most
8192 rows. A success refunds its IP slot and clears its account bucket.
Expired rows are swept at most 50 per reservation.

## Custom Pages and public shares

`pages` arranges pages; it is not a data permission. Each widget needs the
permission of its source (`lib/widget-permissions.ts`): Sales KPI →
`dashboard`, Projects widgets → `projects`, Finance-backed → `finance`;
headers, notes and manual KPIs need nothing more. This is enforced on widget
create and update (by the STORED type), on template pages, and on share create
and update. A share records its owner (migration `0010_share_owner`), and the
public share route re-reads that owner's CURRENT access on every request:
a revoked permission, a deactivated owner or a later widget-type change stops
the link serving that data at once. Legacy shares with no owner serve only
permission-free widgets until an authorised user re-saves them.

## Operational errors

Sync and Backfill return and store only fixed, pre-written messages
(`lib/safe-errors.ts`): a `SafeBitrixError`, the D1 write-quota notice, or a
fixed fallback. No raw `Error.message`, SQL or driver text is ever returned.

## Request security

Every application API has a centralized session/permission guard. Browser
mutations with a cross-site `Origin` or `Sec-Fetch-Site: cross-site` are rejected;
same-site cookies provide the second CSRF boundary. Missing `Origin` remains
available to non-browser operator clients, which do not automatically attach a
session cookie. Login failures are keyed by a hash of normalized email plus
client address, limited to five failures per 15-minute window, and released
after a 10-minute temporary block. Unknown and inactive users receive the same
credential error and unknown users still execute the KDF cost.

The public `/share/[token]` reader remains intentionally outside `/api`; its
separate opaque share-token authorization is unchanged. All share-management
APIs require the `pages` permission.
