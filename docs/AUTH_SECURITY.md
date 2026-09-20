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

Apply `drizzle/0008_auth_core.sql` to the intended D1 first. Then, from a secure
operator terminal, run:

```sh
npm run auth:bootstrap-admin -- \
  --target staging \
  --config /absolute/path/to/staging.wrangler.jsonc \
  --database bitrix-dashboard-staging \
  --email admin@example.com \
  --name "Dashboard Admin"
```

The temporary password is read twice from a hidden TTY prompt; it is never a
command argument, URL, log line, or committed file. The command validates that
both the Worker and D1 names explicitly match the target. It uses an atomic
`INSERT ... WHERE NOT EXISTS`, so it refuses to create or overwrite an Admin
after any user exists. Production additionally requires
`--confirm-production`.

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
