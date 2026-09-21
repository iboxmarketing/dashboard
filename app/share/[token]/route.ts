import { listProjectUpdates, listProjects } from "@/lib/projects-storage";
import { listAnalyticsRecords } from "@/lib/storage";
import { buildSharePayload, shareDataNeeds } from "@/lib/share-model";
import { renderSharePage } from "@/lib/share-render";
import { sharePageResponse, shareUnavailableResponse } from "@/lib/share-http";
import { resolveShareByToken, touchShareAccess } from "@/lib/share-storage";
import { loadUserAccess } from "@/lib/auth/storage";
import { publicShareWidgetIds } from "@/lib/widget-permissions";

/**
 * Public, read-only, server-rendered share route.
 *
 * A route handler rather than a page component on purpose: it lets this route
 * return a real 404, set its own privacy headers, and emit a complete document
 * with no JavaScript at all. The recipient never loads — and never needs — the
 * authenticated dashboard bundle.
 *
 * The token is a bearer credential. It is not logged, not echoed into the
 * document, and not passed to anything but the hash lookup.
 */

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await context.params;
    const resolved = await resolveShareByToken(token);
    if (!resolved) return shareUnavailableResponse();

    // Re-check the share owner's CURRENT access on every read: a permission
    // revoked, an account deactivated, or a widget changed since the share was
    // made all take effect immediately. Nothing loads for a withheld widget.
    const owner = resolved.share.ownerUserId ? await loadUserAccess(resolved.share.ownerUserId) : null;
    const allowedWidgetIds = publicShareWidgetIds(resolved.share.widgetIds, resolved.widgets, owner);

    // Only the datasets the allowed widgets actually need are ever loaded.
    const needs = shareDataNeeds(resolved.widgets, allowedWidgetIds);
    const [records, projects, updates] = await Promise.all([
      needs.analytics ? listAnalyticsRecords() : Promise.resolve([]),
      needs.projects ? listProjects() : Promise.resolve([]),
      needs.projects ? listProjectUpdates() : Promise.resolve([]),
    ]);

    const payload = buildSharePayload({
      page: resolved.page,
      widgets: resolved.widgets,
      allowedWidgetIds,
      records, projects, updates,
    });

    // Opening a share reads the cached dataset only; it never triggers a sync.
    await touchShareAccess(resolved.share.id);
    return sharePageResponse(renderSharePage(payload));
  } catch {
    // Errors must not distinguish themselves from a missing share either.
    return shareUnavailableResponse();
  }
}
