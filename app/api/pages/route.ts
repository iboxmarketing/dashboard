import {
  addWidget, applyWidgetOrder, createPage, deletePage, deleteWidget, listPageWidgets,
  listPages, setPageArchived, updatePage, updateWidget,
} from "@/lib/custom-pages-storage";
import {
  moveWidget, templateById, validatePageInput, validateWidgetConfig, validateWidgetInput,
  type PageWidget,
} from "@/lib/custom-pages";

export async function GET() {
  try {
    const [pages, widgets] = await Promise.all([listPages(), listPageWidgets()]);
    return Response.json({ pages, widgets });
  } catch {
    return Response.json({ error: "Sahifalarni yuklab bo‘lmadi" }, { status: 500 });
  }
}

export async function POST(request: Request) {
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
      await deletePage(id);
      return Response.json({ ok: true });
    }

    if (action === "addWidget") {
      const parsed = validateWidgetInput(payload);
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
      return Response.json({ id: await addWidget(parsed.value) });
    }

    if (action === "updateWidget") {
      if (!id || !pageId) return Response.json({ error: "Widget ID kerak" }, { status: 400 });
      const parsed = validateWidgetConfig(payload.widgetType, payload.config);
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
      await updateWidget(id, { pageId, title: String(payload.title ?? "").trim().slice(0, 200), config: parsed.value });
      return Response.json({ ok: true });
    }

    if (action === "deleteWidget") {
      if (!id || !pageId) return Response.json({ error: "Widget ID kerak" }, { status: 400 });
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
      const newPageId = await createPage({ name: template.name, description: "", audience: template.audience, defaultRange: "30" });
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
