import { listProjectUpdates, listProjects } from "@/lib/projects-storage";
import { listAnalyticsRecords } from "@/lib/storage";
import { buildSharePayload, shareDataNeeds } from "@/lib/share-model";
import { renderSharePage } from "@/lib/share-render";
import { sharePageResponse, shareUnavailableResponse } from "@/lib/share-http";
import { resolveShareByToken, touchShareAccess } from "@/lib/share-storage";

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

    // Only the datasets the allowed widgets actually need are ever loaded.
    const needs = shareDataNeeds(resolved.widgets, resolved.share.widgetIds);
    const [records, projects, updates] = await Promise.all([
      needs.analytics ? listAnalyticsRecords() : Promise.resolve([]),
      needs.projects ? listProjects() : Promise.resolve([]),
      needs.projects ? listProjectUpdates() : Promise.resolve([]),
    ]);

    const payload = buildSharePayload({
      page: resolved.page,
      widgets: resolved.widgets,
      allowedWidgetIds: resolved.share.widgetIds,
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
