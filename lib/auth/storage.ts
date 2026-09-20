import { getD1 } from "@/db";
import { PERMISSION_KEYS, normalizeMemberPermissions, type PermissionKey } from "./permissions";
import { createSessionToken, hashOpaqueToken, LAST_SEEN_WRITE_INTERVAL_MS, sessionIsUsable, SESSION_TTL_SECONDS } from "./security";
import { isAuthRole, normalizeEmail, type AuthContext, type AuthRole, type AuthSession, type AuthUser, type PublicAuthUser } from "./types";

type UserRow = {
  id: string; email: string; name: string; role: string; password_hash: string;
  must_change_password: number; active: number; created_at: string; updated_at: string; last_login_at: string | null;
};
type SessionRow = {
  id: string; token_hash: string; user_id: string; created_at: string; expires_at: string; last_seen_at: string; revoked_at: string | null;
};

function userFromRow(row: UserRow): AuthUser {
  if (!isAuthRole(row.role)) throw new Error("Invalid stored auth role");
  return {
    id: row.id, email: row.email, name: row.name, role: row.role, passwordHash: row.password_hash,
    mustChangePassword: Boolean(row.must_change_password), active: Boolean(row.active),
    createdAt: row.created_at, updatedAt: row.updated_at, lastLoginAt: row.last_login_at,
  };
}
function publicUser(user: AuthUser, permissions: string[]): PublicAuthUser {
  return {
    id: user.id, email: user.email, name: user.name, role: user.role,
    mustChangePassword: user.mustChangePassword, active: user.active,
    createdAt: user.createdAt, updatedAt: user.updatedAt, lastLoginAt: user.lastLoginAt,
    permissions,
  };
}
function sessionFromRow(row: SessionRow): AuthSession {
  return { id: row.id, tokenHash: row.token_hash, userId: row.user_id, createdAt: row.created_at, expiresAt: row.expires_at, lastSeenAt: row.last_seen_at, revokedAt: row.revoked_at };
}
async function permissionRows(userId: string) {
  const result = await getD1().prepare("SELECT permission_key FROM app_user_permissions WHERE user_id = ? ORDER BY permission_key").bind(userId).all<{ permission_key: string }>();
  return normalizeMemberPermissions(result.results.map((row) => row.permission_key));
}

export async function findUserByEmail(email: string) {
  const row = await getD1().prepare("SELECT * FROM app_users WHERE email = ? COLLATE NOCASE LIMIT 1").bind(normalizeEmail(email)).first<UserRow>();
  return row ? userFromRow(row) : null;
}
export async function findUserById(id: string) {
  const row = await getD1().prepare("SELECT * FROM app_users WHERE id = ? LIMIT 1").bind(id).first<UserRow>();
  return row ? userFromRow(row) : null;
}
export async function countActiveAdminsExcluding(id: string) {
  const row = await getD1().prepare("SELECT COUNT(*) AS count FROM app_users WHERE role = 'ADMIN' AND active = 1 AND id <> ?").bind(id).first<{ count: number }>();
  return Number(row?.count ?? 0);
}
export async function listUsers(): Promise<PublicAuthUser[]> {
  const rows = await getD1().prepare("SELECT * FROM app_users ORDER BY name COLLATE NOCASE, email COLLATE NOCASE").all<UserRow>();
  return Promise.all(rows.results.map(async (row) => {
    const user = userFromRow(row);
    return publicUser(user, user.role === "ADMIN" ? [...PERMISSION_KEYS] : await permissionRows(user.id));
  }));
}

export async function createUser(input: { email: string; name: string; role: AuthRole; passwordHash: string; permissions: PermissionKey[]; mustChangePassword?: boolean }) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const db = getD1();
  const statements: D1PreparedStatement[] = [db.prepare(`INSERT INTO app_users
    (id, email, name, role, password_hash, must_change_password, active, created_at, updated_at, last_login_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`).bind(id, normalizeEmail(input.email), input.name.trim(), input.role, input.passwordHash, input.mustChangePassword === false ? 0 : 1, now, now)];
  if (input.role === "MEMBER") {
    for (const key of normalizeMemberPermissions(input.permissions)) statements.push(db.prepare("INSERT INTO app_user_permissions (user_id, permission_key, created_at) VALUES (?, ?, ?)").bind(id, key, now));
  }
  await db.batch(statements);
  return id;
}

export async function updateUser(input: { id: string; email?: string; name?: string; role?: AuthRole; active?: boolean; passwordHash?: string; mustChangePassword?: boolean; permissions?: PermissionKey[] }) {
  const existing = await findUserById(input.id);
  if (!existing) return false;
  const role = input.role ?? existing.role;
  const active = input.active ?? existing.active;
  const now = new Date().toISOString();
  const db = getD1();
  const statements: D1PreparedStatement[] = [db.prepare(`UPDATE app_users SET email = ?, name = ?, role = ?, active = ?, password_hash = ?, must_change_password = ?, updated_at = ? WHERE id = ?`)
    .bind(normalizeEmail(input.email ?? existing.email), (input.name ?? existing.name).trim(), role, active ? 1 : 0,
      input.passwordHash ?? existing.passwordHash, (input.mustChangePassword ?? existing.mustChangePassword) ? 1 : 0, now, existing.id)];
  if (input.permissions !== undefined || role === "ADMIN") {
    statements.push(db.prepare("DELETE FROM app_user_permissions WHERE user_id = ?").bind(existing.id));
    if (role === "MEMBER") {
      for (const key of normalizeMemberPermissions(input.permissions ?? [])) statements.push(db.prepare("INSERT INTO app_user_permissions (user_id, permission_key, created_at) VALUES (?, ?, ?)").bind(existing.id, key, now));
    }
  }
  if (!active || input.passwordHash) statements.push(db.prepare("UPDATE app_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?").bind(now, existing.id));
  await db.batch(statements);
  return true;
}

export async function createSession(userId: string) {
  const token = createSessionToken();
  const tokenHash = await hashOpaqueToken(token);
  const now = new Date();
  const session: AuthSession = {
    id: crypto.randomUUID(), tokenHash, userId, createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString(), lastSeenAt: now.toISOString(), revokedAt: null,
  };
  await getD1().prepare("INSERT INTO app_sessions (id, token_hash, user_id, created_at, expires_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)")
    .bind(session.id, session.tokenHash, session.userId, session.createdAt, session.expiresAt, session.lastSeenAt).run();
  return { token, session };
}

export async function resolveSession(rawToken: string): Promise<AuthContext | null> {
  const tokenHash = await hashOpaqueToken(rawToken);
  const row = await getD1().prepare("SELECT * FROM app_sessions WHERE token_hash = ? LIMIT 1").bind(tokenHash).first<SessionRow>();
  if (!row) return null;
  const session = sessionFromRow(row);
  const now = new Date();
  const user = await findUserById(session.userId);
  if (!sessionIsUsable(session, user, now) || !user) return null;
  const permissions = user.role === "ADMIN" ? [...PERMISSION_KEYS] : await permissionRows(user.id);
  if (now.getTime() - new Date(session.lastSeenAt).getTime() >= LAST_SEEN_WRITE_INTERVAL_MS) {
    const seen = now.toISOString();
    await getD1().prepare("UPDATE app_sessions SET last_seen_at = ? WHERE id = ? AND last_seen_at = ? AND revoked_at IS NULL").bind(seen, session.id, session.lastSeenAt).run();
    session.lastSeenAt = seen;
  }
  const safeSession = {
    id: session.id, userId: session.userId, createdAt: session.createdAt, expiresAt: session.expiresAt,
    lastSeenAt: session.lastSeenAt, revokedAt: session.revokedAt,
  };
  return { user: publicUser(user, permissions), session: safeSession };
}

export async function revokeSession(rawToken: string) {
  const tokenHash = await hashOpaqueToken(rawToken);
  await getD1().prepare("UPDATE app_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash = ?").bind(new Date().toISOString(), tokenHash).run();
}
export async function completeLogin(userId: string) {
  await getD1().prepare("UPDATE app_users SET last_login_at = ? WHERE id = ?").bind(new Date().toISOString(), userId).run();
}
export async function changeOwnPassword(userId: string, passwordHash: string) {
  const now = new Date().toISOString();
  const db = getD1();
  await db.batch([
    db.prepare("UPDATE app_users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?").bind(passwordHash, now, userId),
    db.prepare("UPDATE app_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?").bind(now, userId),
  ]);
}

export async function loginThrottleKey(email: string, address: string) { return hashOpaqueToken(`${normalizeEmail(email)}|${address}`); }
export async function loginThrottleStatus(key: string) {
  return getD1().prepare("SELECT failure_count, window_started_at, blocked_until FROM app_login_attempts WHERE key_hash = ?").bind(key)
    .first<{ failure_count: number; window_started_at: string; blocked_until: string | null }>();
}
export async function recordLoginFailure(key: string) {
  const now = new Date();
  const existing = await loginThrottleStatus(key);
  const reset = !existing || now.getTime() - new Date(existing.window_started_at).getTime() > 15 * 60 * 1000;
  const count = reset ? 1 : existing.failure_count + 1;
  const blocked = count >= 5 ? new Date(now.getTime() + 10 * 60 * 1000).toISOString() : null;
  await getD1().prepare(`INSERT INTO app_login_attempts (key_hash, failure_count, window_started_at, blocked_until, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(key_hash) DO UPDATE SET failure_count = excluded.failure_count,
    window_started_at = excluded.window_started_at, blocked_until = excluded.blocked_until, updated_at = excluded.updated_at`)
    .bind(key, count, reset ? now.toISOString() : existing!.window_started_at, blocked, now.toISOString()).run();
}
export async function clearLoginFailures(key: string) { await getD1().prepare("DELETE FROM app_login_attempts WHERE key_hash = ?").bind(key).run(); }
