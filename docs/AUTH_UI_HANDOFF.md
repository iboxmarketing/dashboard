# Auth UI + User Access Management — handoff

Branch `feat/auth-ui`, based on `cd1d418` (`feat/finance-integration`), which contains
the `feat/analytics-integration` tip, so no Sales or seller work is regressed.

This lane is UI only. It adds no backend, no migration, no D1 write and no deploy.

## 1. Contract this UI expects

| Endpoint | Method | Sends | Expects |
| --- | --- | --- | --- |
| `/api/auth/me` | GET | — | the signed-in user, or 401/403 when not signed in |
| `/api/auth/login` | POST | `{ email, password }` | the user; 401 on any failure |
| `/api/auth/logout` | POST | — | 200/204 |
| `/api/auth/change-password` | POST | `{ currentPassword, newPassword }` | the user, `mustChangePassword: false` |
| `/api/admin/users` | GET | — | `{ users: [...] }` or a bare array |
| `/api/admin/users` | POST | `NewUser` | `{ id }` |
| `/api/admin/users` | PATCH | `UserPatch` | 200/204 |

A user is `{ id, email, name, role, mustChangePassword, active, permissions[], lastLoginAt }`.
Unknown permission keys and an unknown role are dropped by `readUser`, so a backend
change cannot widen access by accident.

## 2. Roles

`ADMIN` and `MEMBER` only. ADMIN access is derived from the role in `canAccess`,
never from the stored list — a stored list can drift, the role cannot. The backend
may therefore store `permissions: []` for an admin.

## 3. The twelve permission keys

`dashboard, managers, leadFlow, quality, stages, deals, finance, projects, pages,
diagnostics, settings, users`. `lib/auth-permissions.ts` is the single mapping;
nothing else may decide access, and no code branches on an email, name or id.

## 4. Derived views

`managerDetail`, `projectDetail` and `pageDetail` carry no key of their own and
inherit `managers`, `projects` and `pages`.

## 5. Startup

`AuthGate` renders `loading` until `/api/auth/me` answers. The dashboard mounts
inside the gate, so no section and no analytics request happens for an
unidentified visitor, and restricted navigation never flashes. A network or 5xx
failure is a fatal state with a retry — never a login form that cannot work.

## 6. Login

One message for every failure (`GENERIC_LOGIN_ERROR`), so the form cannot
enumerate emails or reveal deactivated accounts. No forgot-password link, because
the contract has no reset endpoint; the copy points at the administrator. No
hosting or Cloudflare wording.

## 7. Must-change-password

`mustChangePassword: true` renders a blocking screen; `children` is never reached.
Only "Chiqish" is available beside it. The same screen is reachable voluntarily
from the profile menu, where it has a Cancel.

## 8. Navigation

`app/dashboard-client.tsx` filters `navItems` through `allowedNavEntries`. The
landing view is `firstAllowedView`, and the rendered view is derived per render
through `resolveView`, so a section lost mid-session is never painted. A member
with no sections sees an explanation, not an empty shell.

## 9. Users screen

ADMIN-only (`users` permission). Table: Name, Email, Role, Status, access summary,
last login, edit. Search plus role and status filters. Loading skeleton, empty
list and API error are distinct states.

## 10. Create and edit

Grouped permission checkboxes, never a JSON field. For ADMIN the boxes are checked
and disabled under "Admin barcha bo'limlarga kiradi". A temporary password is
write-only: the field opens empty on edit and is only sent when filled, and no
response carries a password back. Deactivate, promote to ADMIN and password reset
each confirm first. An admin cannot deactivate or demote their own account.

## 11. Enforcement

The frontend is convenience only. Every rule here must also hold in the API: the
backend rejects the same calls independently, and a 403 renders as
"Bu bo'limga kirish huquqingiz yo'q." Fixtures are test-only — `createAuthAdapter`
defaults to `mode: "api"` with no fallback path, and a fixture adapter throws in a
production build.

## 12. What is still open for the backend lane

- Session cookie issuance, expiry and `same-origin` handling.
- Password hashing, the temporary-password lifecycle and any rate limiting.
- Server-side permission checks on every analytics, finance and admin route.
- Seeding the first ADMIN.
- Whether `lastLoginAt` is recorded; the UI shows "Hech qachon" until it is.

Manual smoke is still required for interactions no static render covers: opening
the profile menu, submitting login, the drawer confirmations and the reload after
save. No browser is available in this environment.
