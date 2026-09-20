import type { AuthRole } from "./types";

export const PERMISSIONS = [
  { key: "dashboard", label: "Dashboard", views: ["dashboard"], apiScopes: ["/api/bootstrap", "/api/dashboard"], risk: "read" },
  { key: "managers", label: "Menejerlar", views: ["managers", "managerDetail"], apiScopes: ["/api/dashboard"], risk: "read" },
  { key: "leadFlow", label: "Lead oqimi", views: ["leadFlow"], apiScopes: ["/api/dashboard"], risk: "read" },
  { key: "quality", label: "Sifat", views: ["quality"], apiScopes: ["/api/dashboard"], risk: "read" },
  { key: "stages", label: "Bosqichlar", views: ["stages"], apiScopes: ["/api/current-stages", "/api/stage-funnel"], risk: "read" },
  { key: "deals", label: "Deallar", views: ["deals"], apiScopes: ["/api/dashboard"], risk: "read" },
  { key: "finance", label: "Finance", views: ["finance"], apiScopes: ["/api/finance/*"], risk: "financial" },
  { key: "projects", label: "Loyihalar", views: ["projects", "projectDetail"], apiScopes: ["/api/projects"], risk: "write" },
  { key: "pages", label: "Sahifalar", views: ["pages", "pageDetail"], apiScopes: ["/api/pages", "/api/shares"], risk: "write" },
  { key: "diagnostics", label: "Diagnostika", views: ["diagnostics"], apiScopes: ["/api/providers", "/api/reconcile"], risk: "operational" },
  { key: "settings", label: "Sozlamalar", views: ["settings"], apiScopes: ["/api/settings", "/api/pipelines", "/api/test-connection", "/api/sync", "/api/backfill"], risk: "administrative" },
  { key: "users", label: "Foydalanuvchilar", views: ["users"], apiScopes: ["/api/admin/users"], risk: "administrative" },
] as const;
export type PermissionKey = (typeof PERMISSIONS)[number]["key"];
export const PERMISSION_KEYS = PERMISSIONS.map((item) => item.key) as PermissionKey[];
export function isPermissionKey(value: unknown): value is PermissionKey { return typeof value === "string" && PERMISSION_KEYS.includes(value as PermissionKey); }
export function normalizePermissions(values: unknown): PermissionKey[] { return Array.isArray(values) ? [...new Set(values.filter(isPermissionKey))] : []; }
export function normalizeMemberPermissions(values: unknown): PermissionKey[] { return normalizePermissions(values).filter((key) => key !== "users"); }
export function hasPermission(role: AuthRole, permissions: readonly string[], key: PermissionKey) {
  if (role === "ADMIN") return true;
  if (key === "users") return false;
  return permissions.includes(key);
}
export function permissionForView(view: string): PermissionKey | null {
  return PERMISSIONS.find((item) => (item.views as readonly string[]).includes(view))?.key ?? null;
}
