import { getSettings, getSyncState, listAnalyticsRecords, listProviderDiagnostics } from "@/lib/storage";

export async function GET() {
  try {
    const [records, settings, sync, providers] = await Promise.all([
      listAnalyticsRecords(),
      getSettings(),
      getSyncState(),
      listProviderDiagnostics(),
    ]);
    return Response.json({ records, settings, sync, providers });
  } catch {
    return Response.json({ error: "Dashboard ma’lumotlarini yuklab bo‘lmadi" }, { status: 500 });
  }
}

