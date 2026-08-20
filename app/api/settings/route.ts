import { defaultSettings } from "@/lib/business-time";
import { getSettings, saveSettings } from "@/lib/storage";
import type { DashboardSettings } from "@/lib/types";

export async function POST(request: Request) {
  try {
    const current = await getSettings();
    const payload = (await request.json()) as Partial<DashboardSettings>;
    const next: DashboardSettings = {
      ...defaultSettings,
      ...current,
      ...payload,
      schedule: { ...current.schedule, ...(payload.schedule ?? {}) },
      timezone: "Asia/Tashkent",
      slaMinutes: Math.min(240, Math.max(1, Number(payload.slaMinutes ?? current.slaMinutes))),
      historyDays: Math.min(365, Math.max(1, Number(payload.historyDays ?? current.historyDays))),
      holidays: Array.isArray(payload.holidays) ? payload.holidays.filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)) : current.holidays,
    };
    await saveSettings(next);
    return Response.json({ settings: next });
  } catch {
    return Response.json({ error: "Sozlamalarni saqlab bo‘lmadi" }, { status: 400 });
  }
}

