import {
  addWidget, applyWidgetOrder, createPage, deletePage, deleteWidget, listPageWidgets,
  listPages, setPageArchived, updatePage, updateWidget,
} from "@/lib/custom-pages-storage";
import {
  moveWidget, pageRangeBounds, resolveWidgetCustomRange, resolveWidgetRange, templateById, validatePageInput, validateWidgetConfig, validateWidgetInput,
  type PageWidget,
} from "@/lib/custom-pages";
import { deleteShareWidgetLinks, deleteSharesForPage } from "@/lib/share-storage";
import { authError, requirePermission } from "@/lib/auth/http";
import { hasPermission } from "@/lib/auth/permissions";
import { loadSalesRecords } from "@/lib/sales-http";
import { salesKpiValue } from "@/lib/sales-sections";
import { canUseWidget, WIDGET_FORBIDDEN } from "@/lib/widget-permissions";

/**
 * A page's SALES_KPI widgets are computed here, and only for a caller who also
 * holds `dashboard`: a page is a container, and it must not become a way round
 * the Sales permissions. Without `dashboard` the widget is returned without a
 * value and renders as locked. The records never reach the browser either way.
 */
export async function GET(request: Request) {
  let canDashboard = false;
  try {
    const context = await requirePermission(request, "pages");
    canDashboard = hasPermission(context.user.role, context.user.permissions, "dashboard");
  } catch (error) {
    return authError(error) ?? Response.json({ error: "Kirishni tekshirib bo‘lmadi" }, { status: 500 });
  }
  try {
    const [pages, widgets] = await Promise.all([listPages(), listPageWidgets()]);
    const kpis = widgets.filter((widget) => widget.widgetType === "SALES_KPI");
    const salesKpi: Record<string, { label: string; value: string }> = {};
    if (canDashboard && kpis.length) {
      const { records } = await loadSalesRecords();
      const now = new Date();
      for (const widget of kpis) {
        const page = pages.find((candidate) => candidate.id === widget.pageId);
        if (!page) continue;
        const range = resolveWidgetRange(widget.config, page.defaultRange);
        const bounds = pageRangeBounds(range, now, resolveWidgetCustomRange(widget.config, page));
        salesKpi[widget.id] = salesKpiValue(records, bounds.from, bounds.to, String(widget.config.metricId));
      }
    }
    return Response.json({ pages, widgets, salesKpi, salesKpiLocked: !canDashboard }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "Sahifalarni yuklab bo‘lmadi" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let caller;
  try { caller = await requirePermission(request, "pages"); }
  catch (error) { return authError(error) ?? Response.json({ error: "Kirishni tekshirib bo‘lmadi" }, { status: 500 }); }
  // `pages` arranges a page; each data widget needs its own data permission.
  const access = { role: caller.user.role, permissions: caller.user.permissions, active: caller.user.active };
  const forbidden = () => Response.json({ error: WIDGET_FORBIDDEN, code: "FORBIDDEN" }, { status: 403 });
  try {
    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(payload.action ?? "");
    const id = String(payload.id ?? "").trim();
    const pageId = String(payload.pageId ?? "").trim();

    if (action === "createPage" || action === "updatePage") {
      const parsed = validatePageInput(payload);
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
      if (action === "createPage") return Response.json({ id: await createPage(parsed.value) });
      if (!id) return Response.json({ error: "Sahifa ID kerak" }, { status: 400 });
      await updatePage(id, parsed.value);
      return Response.json({ ok: true });
    }

    if (action === "archivePage" || action === "restorePage") {
      if (!id) return Response.json({ error: "Sahifa ID kerak" }, { status: 400 });
      await setPageArchived(id, action === "archivePage");
      return Response.json({ ok: true });
    }

    if (action === "deletePage") {
      if (!id) return Response.json({ error: "Sahifa ID kerak" }, { status: 400 });
      if (payload.confirm !== true) return Response.json({ error: "Tasdiqlanmagan" }, { status: 400 });
      // Share links die with their page, and before it, so no foreign key is
      // left dangling on stores that do not cascade.
      await deleteSharesForPage(id);
      await deletePage(id);
      return Response.json({ ok: true });
    }

    if (action === "addWidget") {
      const parsed = validateWidgetInput(payload);
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
      if (!canUseWidget(access, parsed.value.widgetType)) return forbidden();
      return Response.json({ id: await addWidget(parsed.value) });
    }

    if (action === "updateWidget") {
      if (!id || !pageId) return Response.json({ error: "Widget ID kerak" }, { status: 400 });
      // The STORED type decides — a client cannot relabel a Sales widget to
      // slip past the check or validate its config against another type.
      const stored = ((await listPageWidgets()) as PageWidget[]).find((widget) => widget.id === id && widget.pageId === pageId);
      if (!stored) return Response.json({ error: "Widget topilmadi" }, { status: 404 });
      if (!canUseWidget(access, stored.widgetType)) return forbidden();
      const parsed = validateWidgetConfig(stored.widgetType, payload.config);
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
      await updateWidget(id, { pageId, title: String(payload.title ?? "").trim().slice(0, 200), config: parsed.value });
      return Response.json({ ok: true });
    }

    if (action === "deleteWidget") {
      if (!id || !pageId) return Response.json({ error: "Widget ID kerak" }, { status: 400 });
      await deleteShareWidgetLinks(id);
      await deleteWidget(id, pageId);
      return Response.json({ ok: true });
    }

    if (action === "moveWidget") {
      if (!id || !pageId) return Response.json({ error: "Widget ID kerak" }, { status: 400 });
      const direction = payload.direction === "up" ? "up" : "down";
      const widgets = (await listPageWidgets()) as PageWidget[];
      await applyWidgetOrder(pageId, moveWidget(widgets, pageId, id, direction));
      return Response.json({ ok: true });
    }

    if (action === "createFromTemplate") {
      const template = templateById(String(payload.templateId ?? ""));
      if (!template) return Response.json({ error: "Shablon topilmadi" }, { status: 400 });
      // A template is refused whole rather than silently thinned out.
      if (template.widgets.some((widget) => !canUseWidget(access, widget.widgetType))) return forbidden();
      const newPageId = await createPage({ name: template.name, description: "", audience: template.audience, defaultRange: "30", defaultFrom: null, defaultTo: null });
      for (const widget of template.widgets) {
        const parsed = validateWidgetConfig(widget.widgetType, widget.config);
        if (!parsed.ok) continue;
        await addWidget({ pageId: newPageId, widgetType: widget.widgetType, title: widget.title, position: 0, config: parsed.value });
      }
      return Response.json({ id: newPageId });
    }

    return Response.json({ error: "Noma’lum amal" }, { status: 400 });
  } catch {
    return Response.json({ error: "Amalni bajarib bo‘lmadi" }, { status: 500 });
  }
}
