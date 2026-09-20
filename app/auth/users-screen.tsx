"use client";

import { Pencil, Plus, RefreshCw, UserPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ActiveBadge, AuthErrorState, RoleBadge } from "./auth-primitives";
import { UserDrawer } from "./user-drawer";
import { AuthError, type AuthAdapter } from "@/lib/auth-adapter";
import { accessSummary } from "@/lib/auth-permissions";
import { ROLES, ROLE_LABELS, type AuthUser, type NewUser, type Role, type UserPatch } from "@/lib/auth-types";

type ActiveFilter = "all" | "active" | "inactive";
type RoleFilter = "all" | Role;

/** Absolute, never "3 kun oldin" — an audit reader needs the date itself. */
function formatLastLogin(value: string | null | undefined): string {
  if (!value) return "Hech qachon";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleString("uz-UZ", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function matchesUserFilters(user: AuthUser, search: string, role: RoleFilter, active: ActiveFilter): boolean {
  const needle = search.trim().toLocaleLowerCase();
  if (needle && !`${user.name} ${user.email}`.toLocaleLowerCase().includes(needle)) return false;
  if (role !== "all" && user.role !== role) return false;
  if (active === "active" && !user.active) return false;
  if (active === "inactive" && user.active) return false;
  return true;
}

/**
 * The table, presentational so it can be asserted without a DOM.
 *
 * Access is shown as a readable summary — "Barcha bo‘limlar", a section list, or
 * "Bo‘lim biriktirilmagan" — because an admin scanning the list needs to spot the
 * user who can see nothing, and a permission-count badge hides exactly that.
 */
export function UsersTable({ users, selfId, onEdit }: {
  users: AuthUser[]; selfId: string | null; onEdit: (user: AuthUser) => void;
}) {
  return (
    <div className="table-wrap users-table">
      <table>
        <thead>
          <tr>
            <th>Ism</th><th>Email</th><th>Rol</th><th>Holat</th><th>Ruxsatlar</th><th>Oxirgi kirish</th><th aria-label="Amallar" />
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id} className={user.active ? "" : "is-inactive"}>
              <td>
                <span className="users-name">{user.name}</span>
                {user.id === selfId && <span className="users-self">siz</span>}
                {user.mustChangePassword && <span className="users-flag">parol almashtirilmagan</span>}
              </td>
              <td className="users-email">{user.email}</td>
              <td><RoleBadge role={user.role} /></td>
              <td><ActiveBadge active={user.active} /></td>
              <td className="users-access">{accessSummary(user)}</td>
              <td className="users-login">{formatLastLogin(user.lastLoginAt)}</td>
              <td className="users-actions">
                <button type="button" className="button ghost small" onClick={() => onEdit(user)}>
                  <Pencil size={13} aria-hidden="true" />Tahrirlash
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * ADMIN-only user management.
 *
 * The screen is only reachable through the `users` permission, which only an
 * ADMIN has; this is convenience, not enforcement — the backend rejects the same
 * calls independently.
 */
export function UsersScreen({ adapter, selfId, onSelfChanged, onSessionLost }: {
  adapter: AuthAdapter;
  selfId: string | null;
  /** Re-read `me` after an edit that may have changed the signed-in user. */
  onSelfChanged?: () => void;
  /** Called when a call proves the session is gone, so the shell can sign out. */
  onSessionLost?: () => void;
}) {
  // One state object tagged with the request it answers, so "loading" is derived
  // rather than written: an effect that reset state synchronously before its
  // fetch would cascade an extra render on every reload.
  const [loaded, setLoaded] = useState<{ token: number; users: AuthUser[] | null; error: string | null }>(
    { token: -1, users: null, error: null },
  );
  const [reloadToken, setReloadToken] = useState(0);
  const pending = loaded.token !== reloadToken;
  const users = pending ? null : loaded.users;
  const error = pending ? null : loaded.error;
  const [search, setSearch] = useState("");
  const [role, setRole] = useState<RoleFilter>("all");
  const [active, setActive] = useState<ActiveFilter>("all");
  const [editing, setEditing] = useState<AuthUser | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Awaited before any state write: setting state synchronously inside an
    // effect cascades renders.
    const load = async () => {
      try {
        const rows = await adapter.listUsers();
        if (!cancelled) setLoaded({ token: reloadToken, users: rows, error: null });
      } catch (caught) {
        if (cancelled) return;
        // An expired or revoked session is not an error to display; the shell
        // returns to login once, and never retries the call that proved it.
        if (caught instanceof AuthError && caught.status === 401) { onSessionLost?.(); return; }
        setLoaded({
          token: reloadToken, users: null,
          error: caught instanceof AuthError ? caught.message : "Foydalanuvchilar yuklanmadi.",
        });
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [adapter, reloadToken, onSessionLost]);

  const reload = () => setReloadToken((token) => token + 1);
  const visible = useMemo(
    () => (users ?? []).filter((user) => matchesUserFilters(user, search, role, active)),
    [users, search, role, active],
  );

  const create = async (body: NewUser) => { await adapter.createUser(body); reload(); };
  const patch = async (body: UserPatch) => {
    await adapter.updateUser(body);
    reload();
    if (body.id === selfId) onSelfChanged?.();
  };

  return (
    <section className="users-screen">
      <header className="users-head">
        <div>
          <h2>Foydalanuvchilar</h2>
          <p>Kim tizimga kirishi va qaysi bo‘limlarni ko‘rishini boshqaring.</p>
        </div>
        <div className="users-head-actions">
          <button type="button" className="button secondary" onClick={reload} disabled={pending}>
            <RefreshCw size={14} aria-hidden="true" />Yangilash
          </button>
          <button type="button" className="button" onClick={() => setCreating(true)}>
            <Plus size={14} aria-hidden="true" />Yangi foydalanuvchi
          </button>
        </div>
      </header>

      <div className="users-filters">
        <input className="users-search" value={search} placeholder="Ism yoki email…"
          aria-label="Foydalanuvchini qidirish" onChange={(event) => setSearch(event.target.value)} />
        <select value={role} aria-label="Rol bo‘yicha" onChange={(event) => setRole(event.target.value as RoleFilter)}>
          <option value="all">Barcha rollar</option>
          {ROLES.map((option) => <option key={option} value={option}>{ROLE_LABELS[option]}</option>)}
        </select>
        <select value={active} aria-label="Holat bo‘yicha" onChange={(event) => setActive(event.target.value as ActiveFilter)}>
          <option value="all">Barcha holatlar</option>
          <option value="active">Faol</option>
          <option value="inactive">Faol emas</option>
        </select>
      </div>

      {error && <AuthErrorState message={error} onRetry={reload} />}
      {!error && users === null && (
        <div className="users-skeleton" aria-busy="true" aria-live="polite">
          <span className="sr-only">Foydalanuvchilar yuklanmoqda…</span>
          {[0, 1, 2, 3].map((row) => <div key={row} className="skeleton-row" />)}
        </div>
      )}
      {!error && users !== null && users.length === 0 && (
        <div className="empty-state users-empty">
          <UserPlus size={18} aria-hidden="true" />
          <p>Hali foydalanuvchi qo‘shilmagan.</p>
          <button type="button" className="button" onClick={() => setCreating(true)}>Birinchi foydalanuvchini qo‘shish</button>
        </div>
      )}
      {!error && users !== null && users.length > 0 && visible.length === 0 && (
        <p className="users-no-match">Filtrlarga mos foydalanuvchi topilmadi.</p>
      )}
      {!error && visible.length > 0 && <UsersTable users={visible} selfId={selfId} onEdit={setEditing} />}

      {(creating || editing) && (
        <UserDrawer
          key={editing?.id ?? "new"}
          open
          user={editing}
          selfId={selfId}
          onClose={() => { setCreating(false); setEditing(null); }}
          onCreate={create}
          onPatch={patch}
        />
      )}
    </section>
  );
}
