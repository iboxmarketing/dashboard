import { PERMISSION_KEYS, hasPermission, normalizePermissions as normalizeServerPermissions, permissionForView, type PermissionKey } from "./auth/permissions";
import type { AuthUser, Permission } from "./auth-types";

/**
 * The presentation layer of the one permission mapping.
 *
 * `lib/auth/permissions.ts` owns the keys, which views each covers and which API
 * scopes they guard; the API routes read it directly. This module adds only what
 * a screen needs — Uzbek labels, grouping and summaries — and never re-decides
 * access: `canAccess` delegates to the server's `hasPermission`, so the nav and
 * the API can never disagree about who may see what.
 *
 * Nothing anywhere may branch on an email, a name or a user id to decide access.
 * That is how permission logic rots into unauditable special cases.
 */

export type NavGroup = "sales" | "finance" | "management" | "administration";
export const NAV_GROUP_LABELS: Record<NavGroup, string> = {
  sales: "Sales", finance: "Finance", management: "Boshqaruv", administration: "Administratsiya",
};

export type NavEntry = {
  permission: Permission;
  /** The dashboard view id this section renders. */
  view: string;
  label: string;
  group: NavGroup;
  description: string;
};

/** Labels and grouping only — the key list itself comes from the server module. */
const PRESENTATION: Record<PermissionKey, { view: string; label: string; group: NavGroup; description: string }> = {
  dashboard: { view: "dashboard", label: "Dashboard", group: "sales", description: "Sales KPI va umumiy ko‘rsatkichlar" },
  managers: { view: "managers", label: "Menejerlar", group: "sales", description: "Menejerlar reytingi va profillari" },
  leadFlow: { view: "leadFlow", label: "Lead oqimi", group: "sales", description: "Lead oqimi tahlili" },
  quality: { view: "quality", label: "Lead sifati", group: "sales", description: "Sifat va Not Relevant tahlili" },
  stages: { view: "stages", label: "Stage nazorati", group: "sales", description: "Joriy bosqichlar va kechikishlar" },
  deals: { view: "deals", label: "Deal’lar", group: "sales", description: "Deal ro‘yxati va eksport" },
  finance: { view: "finance", label: "Moliya", group: "finance", description: "Hisoblar, yozuvlar, obunalar" },
  projects: { view: "projects", label: "Projects", group: "management", description: "Loyihalar va yangilanishlar" },
  pages: { view: "pages", label: "Pages", group: "management", description: "Maxsus sahifalar va ulashish" },
  diagnostics: { view: "diagnostics", label: "Diagnostika", group: "administration", description: "Sync holati va ma’lumot sifati" },
  settings: { view: "settings", label: "Sozlamalar", group: "administration", description: "Funnel, maydon va SLA sozlamalari" },
  users: { view: "users", label: "Foydalanuvchilar", group: "administration", description: "Foydalanuvchilar va ruxsatlar" },
};

export const NAV_ENTRIES: readonly NavEntry[] = PERMISSION_KEYS.map((permission) => ({
  permission, ...PRESENTATION[permission],
}));

const BY_VIEW = new Map(NAV_ENTRIES.map((entry) => [entry.view, entry]));
const BY_PERMISSION = new Map(NAV_ENTRIES.map((entry) => [entry.permission, entry]));

export const navEntryForView = (view: string) => BY_VIEW.get(view) ?? null;
export const navEntryForPermission = (permission: Permission) => BY_PERMISSION.get(permission) ?? null;

/**
 * Views that carry no permission of their own and are reachable from a parent
 * section. The server's `permissionForView` already lists them against the same
 * keys, so this table exists only to keep the client's lookup local.
 */
export const DERIVED_VIEWS: Record<string, Permission> = {
  managerDetail: "managers",
  projectDetail: "projects",
  pageDetail: "pages",
  // Seller review writes the canonical seller field back to Bitrix, so it rides
  // the ADMIN-only `users` capability rather than any Sales section permission.
  sellerReview: "users",
};

/** Normalises whatever the backend sends, dropping keys outside the contract. */
export function normalizePermissions(value: unknown): Permission[] {
  const accepted = new Set(normalizeServerPermissions(value));
  return PERMISSION_KEYS.filter((permission) => accepted.has(permission));
}

/**
 * The one access question, answered by the server's rule.
 *
 * ADMIN access comes from the role, not a stored list — a list can drift, the
 * role cannot. `users` is refused to every MEMBER even if a row somehow grants
 * it, matching `requireAdmin` on `/api/admin/users`.
 */
export function canAccess(user: Pick<AuthUser, "role" | "permissions" | "active"> | null, permission: Permission): boolean {
  if (!user || !user.active) return false;
  return hasPermission(user.role, user.permissions, permission);
}

/** Can this user open this view? Derived views inherit their parent's permission. */
export function canAccessView(user: Pick<AuthUser, "role" | "permissions" | "active"> | null, view: string): boolean {
  const permission = DERIVED_VIEWS[view] ?? permissionForView(view);
  return permission ? canAccess(user, permission) : false;
}

export function allowedNavEntries(user: Pick<AuthUser, "role" | "permissions" | "active"> | null): NavEntry[] {
  return NAV_ENTRIES.filter((entry) => canAccess(user, entry.permission));
}

export function effectivePermissions(user: Pick<AuthUser, "role" | "permissions"> | null): Permission[] {
  if (!user) return [];
  return PERMISSION_KEYS.filter((permission) => hasPermission(user.role, user.permissions, permission));
}

/**
 * The safe landing view.
 *
 * Used at login and whenever a permission is lost while the user is already on a
 * view — they are moved to their first allowed section rather than left staring
 * at a section they may no longer read.
 */
export function firstAllowedView(user: Pick<AuthUser, "role" | "permissions" | "active"> | null): string | null {
  return allowedNavEntries(user)[0]?.view ?? null;
}

/** Keeps the current view if still permitted, else the first allowed one. */
export function resolveView(user: Pick<AuthUser, "role" | "permissions" | "active"> | null, current: string): { view: string | null; redirected: boolean } {
  if (canAccessView(user, current)) return { view: current, redirected: false };
  const fallback = firstAllowedView(user);
  return { view: fallback, redirected: fallback !== null };
}

export const hasAnySection = (user: Pick<AuthUser, "role" | "permissions" | "active"> | null) => allowedNavEntries(user).length > 0;

/**
 * Grouped permission checkboxes for the admin editor — never a raw JSON field.
 *
 * `users` is omitted: it is an ADMIN-only capability the server refuses to grant
 * to a MEMBER, so offering the box would promise access that cannot exist.
 */
export function permissionGroups(): { group: NavGroup; label: string; entries: NavEntry[] }[] {
  const order: NavGroup[] = ["sales", "finance", "management", "administration"];
  return order.map((group) => ({
    group, label: NAV_GROUP_LABELS[group],
    entries: NAV_ENTRIES.filter((entry) => entry.group === group && entry.permission !== "users"),
  })).filter((section) => section.entries.length > 0);
}

/** Permission keys an admin may actually assign to a MEMBER. */
export const ASSIGNABLE_PERMISSIONS: Permission[] = PERMISSION_KEYS.filter((permission) => permission !== "users");

/** One-line access summary for the admin table. */
export function accessSummary(user: Pick<AuthUser, "role" | "permissions">): string {
  if (user.role === "ADMIN") return "Barcha bo‘limlar";
  const granted = normalizePermissions(user.permissions).filter((permission) => permission !== "users");
  if (!granted.length) return "Bo‘lim biriktirilmagan";
  if (granted.length === ASSIGNABLE_PERMISSIONS.length) return "Barcha bo‘limlar";
  const labels = granted.map((permission) => BY_PERMISSION.get(permission)?.label ?? permission);
  return labels.length <= 3 ? labels.join(", ") : `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`;
}

export function togglePermission(permissions: readonly Permission[], permission: Permission): Permission[] {
  const next = permissions.includes(permission)
    ? permissions.filter((item) => item !== permission)
    : [...permissions, permission];
  return ASSIGNABLE_PERMISSIONS.filter((item) => next.includes(item));
}
