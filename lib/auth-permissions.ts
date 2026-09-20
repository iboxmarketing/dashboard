import { PERMISSIONS, isPermission, type AuthUser, type Permission } from "./auth-types";

/**
 * The single permission mapping.
 *
 * Every section the dashboard can navigate to appears exactly once here, bound to
 * one canonical permission key. Nothing anywhere else may branch on an email, a
 * name or a user id to decide access — that is how permission logic rots into
 * dozens of unauditable special cases.
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

export const NAV_ENTRIES: readonly NavEntry[] = [
  { permission: "dashboard", view: "dashboard", label: "Dashboard", group: "sales", description: "Sales KPI va umumiy ko‘rsatkichlar" },
  { permission: "managers", view: "managers", label: "Menejerlar", group: "sales", description: "Menejerlar reytingi va profillari" },
  { permission: "leadFlow", view: "leadFlow", label: "Lead oqimi", group: "sales", description: "Lead oqimi tahlili" },
  { permission: "quality", view: "quality", label: "Lead sifati", group: "sales", description: "Sifat va Not Relevant tahlili" },
  { permission: "stages", view: "stages", label: "Stage nazorati", group: "sales", description: "Joriy bosqichlar va kechikishlar" },
  { permission: "deals", view: "deals", label: "Deal’lar", group: "sales", description: "Deal ro‘yxati va eksport" },
  { permission: "finance", view: "finance", label: "Moliya", group: "finance", description: "Hisoblar, yozuvlar, obunalar" },
  { permission: "projects", view: "projects", label: "Projects", group: "management", description: "Loyihalar va yangilanishlar" },
  { permission: "pages", view: "pages", label: "Pages", group: "management", description: "Maxsus sahifalar va ulashish" },
  { permission: "diagnostics", view: "diagnostics", label: "Diagnostika", group: "administration", description: "Sync holati va ma’lumot sifati" },
  { permission: "settings", view: "settings", label: "Sozlamalar", group: "administration", description: "Funnel, maydon va SLA sozlamalari" },
  { permission: "users", view: "users", label: "Foydalanuvchilar", group: "administration", description: "Foydalanuvchilar va ruxsatlar" },
];

const BY_VIEW = new Map(NAV_ENTRIES.map((entry) => [entry.view, entry]));
const BY_PERMISSION = new Map(NAV_ENTRIES.map((entry) => [entry.permission, entry]));

export const navEntryForView = (view: string) => BY_VIEW.get(view) ?? null;
export const navEntryForPermission = (permission: Permission) => BY_PERMISSION.get(permission) ?? null;

/** Views that carry no permission of their own; reachable from a parent section. */
export const DERIVED_VIEWS: Record<string, Permission> = {
  managerDetail: "managers",
  projectDetail: "projects",
  pageDetail: "pages",
};

/** Normalises whatever the backend sends, dropping keys outside the contract. */
export function normalizePermissions(value: unknown): Permission[] {
  const raw = Array.isArray(value) ? value : [];
  const seen = new Set<Permission>();
  for (const item of raw) if (isPermission(item)) seen.add(item);
  return PERMISSIONS.filter((permission) => seen.has(permission));
}

/**
 * ADMIN access comes from the role, not from a list. A stored list can drift;
 * the role cannot, so an admin never loses a section to stale data.
 */
export function canAccess(user: Pick<AuthUser, "role" | "permissions" | "active"> | null, permission: Permission): boolean {
  if (!user || !user.active) return false;
  if (user.role === "ADMIN") return true;
  return user.permissions.includes(permission);
}

/** Can this user open this view? Derived views inherit their parent's permission. */
export function canAccessView(user: Pick<AuthUser, "role" | "permissions" | "active"> | null, view: string): boolean {
  const derived = DERIVED_VIEWS[view];
  if (derived) return canAccess(user, derived);
  const entry = BY_VIEW.get(view);
  return entry ? canAccess(user, entry.permission) : false;
}

export function allowedNavEntries(user: Pick<AuthUser, "role" | "permissions" | "active"> | null): NavEntry[] {
  return NAV_ENTRIES.filter((entry) => canAccess(user, entry.permission));
}

export function effectivePermissions(user: Pick<AuthUser, "role" | "permissions"> | null): Permission[] {
  if (!user) return [];
  return user.role === "ADMIN" ? [...PERMISSIONS] : normalizePermissions(user.permissions);
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

/** Grouped permission checkboxes for the admin editor — never a raw JSON field. */
export function permissionGroups(): { group: NavGroup; label: string; entries: NavEntry[] }[] {
  const order: NavGroup[] = ["sales", "finance", "management", "administration"];
  return order.map((group) => ({
    group, label: NAV_GROUP_LABELS[group],
    entries: NAV_ENTRIES.filter((entry) => entry.group === group),
  })).filter((section) => section.entries.length > 0);
}

/** One-line access summary for the admin table. */
export function accessSummary(user: Pick<AuthUser, "role" | "permissions">): string {
  if (user.role === "ADMIN") return "Barcha bo‘limlar";
  const granted = normalizePermissions(user.permissions);
  if (!granted.length) return "Bo‘lim biriktirilmagan";
  if (granted.length === PERMISSIONS.length) return "Barcha bo‘limlar";
  const labels = granted.map((permission) => BY_PERMISSION.get(permission)?.label ?? permission);
  return labels.length <= 3 ? labels.join(", ") : `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`;
}

export function togglePermission(permissions: readonly Permission[], permission: Permission): Permission[] {
  const next = permissions.includes(permission)
    ? permissions.filter((item) => item !== permission)
    : [...permissions, permission];
  return PERMISSIONS.filter((item) => next.includes(item));
}
