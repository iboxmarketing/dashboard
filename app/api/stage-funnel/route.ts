import { listStageFunnelJson } from "@/lib/storage";

/**
 * Stage history for the Stage Control funnel only, fetched when that view is
 * opened. It carries the timeline plus the four fields the view's own filters
 * read — never the full record, and never on the dashboard's initial load.
 */
export async function GET() {
  try {
    const rows = await listStageFunnelJson();
    return new Response(`{"records":[${rows.join(",")}]}`, { headers: { "content-type": "application/json" } });
  } catch {
    return Response.json({ error: "Stage tarixini yuklab bo‘lmadi" }, { status: 500 });
  }
}
