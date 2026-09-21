import { hasPermission, type PermissionKey } from "./auth/permissions";
import type { AuthRole } from "./auth/types";
import { WIDGET_REGISTRY, type WidgetSource, type WidgetType } from "./custom-pages";

/**
 * Which data permission a Custom Page widget needs.
 *
 * `pages` lets someone arrange a page; it is not a data permission. A widget
 * that shows Sales numbers needs `dashboard`, one that shows projects needs
 * `projects`, one backed by Finance needs `finance`. Headers, notes and manual
 * KPIs show only what the author typed and need nothing beyond `pages`.
 *
 * This one table is enforced when a widget is created or updated, when a page
 * is built from a template, when a share is created or updated, and again on
 * every PUBLIC share read against the share owner's CURRENT access — so a
 * later permission change, or a later widget change, is honoured at once.
 */
export const SOURCE_PERMISSION: Record<WidgetSource | "FINANCE", PermissionKey | null> = {
  BITRIX: "dashboard",
  PROJECTS: "projects",
  FINANCE: "finance",
  MANUAL: null,
};

/** Unknown types fail closed: they require a permission nobody but ADMIN has. */
export function widgetPermission(type: string): PermissionKey | null {
  const entry = WIDGET_REGISTRY.find((widget) => widget.type === type);
  if (!entry) return "users";
  return SOURCE_PERMISSION[entry.source];
}

export type Access = { role: AuthRole; permissions: readonly string[]; active: boolean };

export function canUseWidget(access: Access | null, type: WidgetType | string) {
  if (!access || !access.active) return false;
  const permission = widgetPermission(type);
  return permission === null || hasPermission(access.role, access.permissions, permission);
}

/** The widgets of `widgets` this caller may show, in order. */
export function allowedWidgets<T extends { widgetType: string }>(access: Access | null, widgets: readonly T[]) {
  return widgets.filter((widget) => canUseWidget(access, widget.widgetType));
}

export const WIDGET_FORBIDDEN = "Bu widget ma’lumoti uchun ruxsatingiz yo‘q";

/**
 * The widget IDs a PUBLIC share may render right now.
 *
 * Starts from the share's own selection and keeps a data widget only while the
 * share's owner — read fresh on every request — is active and still holds the
 * widget's data permission. A widget whose type changed since the share was
 * made is judged by its current type. Manual widgets need no data permission.
 * A legacy share with no recorded owner, or an owner who is gone or
 * deactivated, keeps its manual widgets and loses every data widget.
 */
export function publicShareWidgetIds<T extends { id: string; widgetType: string }>(
  selectedIds: readonly string[], widgets: readonly T[], ownerAccess: Access | null,
) {
  const selected = new Set(selectedIds);
  return widgets
    .filter((widget) => selected.has(widget.id))
    .filter((widget) => widgetPermission(widget.widgetType) === null || canUseWidget(ownerAccess, widget.widgetType))
    .map((widget) => widget.id);
}
