# Dashboard authentication and access control

Authentication uses server-side D1 sessions. The browser receives a 256-bit
random token in a `__Host-ibox_session` cookie; D1 stores only its SHA-256
digest. The cookie is `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, and lasts
12 hours. Revoked, expired, or inactive-user sessions are rejected. `lastSeenAt`
is written at most once every 15 minutes per active session.

Passwords use PBKDF2-HMAC-SHA-256 with a random 128-bit salt, a 256-bit output,
and 600,000 iterations. The encoded verifier stores the algorithm, work factor,
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

Two bounded buckets (`lib/auth/throttle.ts`): `ip:<n>` where n is a hash of the
client network (IPv4, or the IPv6 /64) modulo 4096, and `user:<id>` only for an
account that exists. An unknown email never creates a row, so the table holds
at most 4096 + user-count rows. No raw address or email is stored. A blocked IP
bucket gets 429 before any PBKDF2 work; a blocked account is answered exactly
like a wrong password. Expired rows are swept at most 50 per write.

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
