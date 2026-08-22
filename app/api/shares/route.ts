import { listPageWidgets, listPages } from "@/lib/custom-pages-storage";
import { createShare, getShare, listShares, revokeShare, updateShare } from "@/lib/share-storage";
import { defaultVisibleWidgetIds, shareUrl, validateShareInput } from "@/lib/share-tokens";
import { pageWidgets } from "@/lib/custom-pages";

/**
 * Authenticated management API for share links.
 *
 * There is no public mutation endpoint: the only unauthenticated surface is
 * GET /share/[token], which renders and never writes anything a caller
 * controls. Responses here carry share metadata only — the raw token appears
 * exactly once, in the createShare reply.
 */
export async function GET() {
  try {
    return Response.json({ shares: await listShares() });
  } catch {
    return Response.json({ error: "Ulashish havolalarini yuklab bo‘lmadi" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(payload.action ?? "");
    const id = String(payload.id ?? "").trim();
    const pageId = String(payload.pageId ?? "").trim();

    if (action === "createShare") {
      if (!pageId) return Response.json({ error: "Sahifa tanlanmagan" }, { status: 400 });
      const [pages, widgets] = await Promise.all([listPages(), listPageWidgets()]);
      const page = pages.find((row) => row.id === pageId);
      if (!page) return Response.json({ error: "Sahifa topilmadi" }, { status: 404 });

      const available = pageWidgets(widgets, pageId);
      // An omitted selection falls back to the conservative defaults rather
      // than to "everything".
      const requested = Array.isArray(payload.widgetIds) ? payload.widgetIds : defaultVisibleWidgetIds(available);
      const parsed = validateShareInput({ ...payload, widgetIds: requested }, available.map((widget) => widget.id));
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

      const { id: shareId, token } = await createShare({ pageId, ...parsed.value });
      const share = await getShare(shareId);
      // The only response in the system that carries a raw token.
      return Response.json({ share, token, url: shareUrl(new URL(request.url).origin, token) });
    }

    if (action === "updateShare") {
      if (!id) return Response.json({ error: "Havola ID kerak" }, { status: 400 });
      const existing = await getShare(id);
      if (!existing) return Response.json({ error: "Havola topilmadi" }, { status: 404 });
      const available = pageWidgets(await listPageWidgets(), existing.pageId);
      const parsed = validateShareInput(payload, available.map((widget) => widget.id));
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
      await updateShare(id, parsed.value);
      return Response.json({ ok: true });
    }

    if (action === "revokeShare") {
      if (!id) return Response.json({ error: "Havola ID kerak" }, { status: 400 });
      await revokeShare(id);
      return Response.json({ ok: true });
    }

    if (action === "listShares") return Response.json({ shares: await listShares() });

    return Response.json({ error: "Noma’lum amal" }, { status: 400 });
  } catch {
    return Response.json({ error: "Amalni bajarib bo‘lmadi" }, { status: 500 });
  }
}
