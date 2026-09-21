# Auth integration — backend + UI on one contract

Branch `feat/auth-integration`, based on `cd1d418` (`feat/finance-integration`).
It integrates `44ba1b6` (auth core, from `feat/auth-core`) and `d523d8e`
(auth UI, from `feat/auth-ui`) and reconciles them into one contract.

Nothing here was deployed, no remote D1 was touched, no migration was executed
remotely, and no Sales or Finance formula was changed.

## 1. Where each half stands

| Concern | Owner | File |
| --- | --- | --- |
| Password hashing, session tokens, CSRF, cookie | server | `lib/auth/{password,security}.ts` |
| Session storage, users, permissions, throttling | server | `lib/auth/storage.ts` |
| Route guards | server | `lib/auth/{http,authorization}.ts` |
| **The permission keys and the access rule** | **server** | **`lib/auth/permissions.ts`** |
| Labels, grouping, nav, summaries | client | `lib/auth-permissions.ts` |
| The only network calls the UI makes | client | `lib/auth-adapter.ts` |
| Screens | client | `app/auth/*` |

`lib/auth-types.ts` re-exports `AUTH_ROLES` and `PERMISSION_KEYS` from the server
modules, and `canAccess` calls the server's `hasPermission`. There is no second
list and no second rule, so the nav and the API cannot disagree.

## 2. The user contract

```
{ id, email, name, role, active, mustChangePassword, permissions[], lastLoginAt }
```

Roles: `ADMIN`, `MEMBER`. Keys: `dashboard, managers, leadFlow, quality, stages,
deals, finance, projects, pages, diagnostics, settings, users`.

ADMIN access derives from the role; the stored list is ignored (and is written
empty). MEMBER gets explicit keys only. `users` is never granted to a MEMBER:
`hasPermission` refuses it, `normalizeMemberPermissions` strips it on write, and
the editor does not offer the box.

## 3. Login

`POST /api/auth/login` → `__Host-ibox_session` cookie → `GET /api/auth/me` →
the app. Every failure — wrong password, unknown email, deactivated account —
returns 401 with one sentence. A 429 throttle message passes through unchanged.
A 5xx or a network fault renders a retryable error state, never the login form.

## 4. Password change

The API verifies the current password, enforces 12–256 characters with upper,
lower and digit, clears `mustChangePassword`, **revokes every session** and
clears the cookie. The UI therefore returns to the login screen with
"Parol almashtirildi. Yangi parol bilan qaytadan kiring." — it does not pretend
the session survived.

While `mustChangePassword` is true, every permissioned route returns 403
`PASSWORD_CHANGE_REQUIRED` and the gate renders the change screen instead of the
app.

## 5. API protection

Every route under `app/api` requires a session and a permission. The only open
handlers are `login`, `logout` (both still call `assertSafeMutation`) and
`app/share/[token]` (bearer-token protected, by existing design). A test
enumerates the routes and fails if that list ever grows.

`/api/admin/users` is `requireAdmin`, not the `users` permission, so it stays
ADMIN-only regardless of what a row stores.

## 6. Session UX

401 → login, cleanly and once (`sessionLost` sets the signed-out state rather
than re-reading `/api/auth/me`, which would only 401 again). 403 → the forbidden
message. Deactivation and password reset revoke sessions server-side, so the next
call lands on login.

## 7. Admin users

Create: name, normalized email, role, temporary password, MEMBER permissions.
The API forces `mustChangePassword` on every create, and the form says so rather
than offering a toggle it cannot honour. Edit: name, email, role, active,
permissions, optional new temporary password. Deactivate, promote and reset each
confirm first, and each states its side effect (sessions close, old password
stops working). Self-demotion, self-deactivation and removing the last active
admin are refused by the server; the drawer refuses the first two early.

No response carries `passwordHash`, a session token or a token hash.

## 8. Migration

`drizzle/0008_auth_core.sql`, journal `0000 … 0007_finance_core, 0008_auth_core`.
No collision and no change to any Finance or CRM table. Not executed remotely.
First admin: `npm run auth:bootstrap-admin` (see `docs/AUTH_SECURITY.md`).

## 9. Manual browser smoke

1. Anonymous load → login screen, no dashboard chrome flashes first.
2. Wrong password, unknown email, deactivated account → the same sentence.
3. Temporary password → change screen; no nav reachable; change → back to login.
4. Log in as an ADMIN → all twelve sections, profile menu shows name/email/role.
5. Create a MEMBER with Finance only → they see Finance alone.
6. With that member signed in, call `/api/dashboard` from devtools → 403.
7. As ADMIN, remove their Finance permission while they are on Finance → they
   move to a permitted section or the no-section state.
8. Deactivate them → their next click lands on login.
9. Reset their password → their open tab lands on login; the new password then
   requires a change.
10. Try to demote yourself or the last admin → refused with the server message.
11. Log out → back button does not restore the dashboard.

## 10. Remaining security notes for the audit

- Login throttling is per email + IP in D1; it is not a global rate limit.
- Sessions last 12 hours with no sliding renewal.
- `assertSafeMutation` trusts `Origin` / `Sec-Fetch-Site`; there is no CSRF token.
- Permission changes take effect on the next request, not on open pages.
