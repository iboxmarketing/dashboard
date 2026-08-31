import { getSettings, getSyncState, listDashboardRecordJson, listProviderDiagnostics } from "@/lib/storage";

/**
 * The record rows arrive from D1 as JSON strings that are already in their
 * final shape, so they are concatenated into the body rather than parsed into
 * objects and serialised again. Parsing and re-serialising 1,699 records cost
 * ~38 ms of Worker CPU and produced exactly the text D1 had already given us.
 */
export async function GET() {
  try {
    const [rows, settings, sync, providers] = await Promise.all([
      listDashboardRecordJson(),
      getSettings(),
      getSyncState(),
      listProviderDiagnostics(),
    ]);
    const body = `{"records":[${rows.join(",")}],"settings":${JSON.stringify(settings)},`
      + `"sync":${JSON.stringify(sync)},"providers":${JSON.stringify(providers)}}`;
    return new Response(body, { headers: { "content-type": "application/json" } });
  } catch {
    return Response.json({ error: "Dashboard ma’lumotlarini yuklab bo‘lmadi" }, { status: 500 });
  }
}
