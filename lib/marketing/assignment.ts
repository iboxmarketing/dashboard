import { WORKSPACE_KEYS, isWorkspaceKey, workspaceForCategory, type WorkspaceKey } from "./workspaces";

/**
 * Which marketing workspace an ad's spend belongs to (owner rules, 2026-10-14).
 *
 * The unit is the AD (Meta Insights are stored per ad and day). Never a whole ad
 * account, never a whole campaign: one account — even one campaign — can feed
 * IBOX UZ (3), Sales Doctor UZ (5), IBOX KZ (41), Sales Doctor KZ (33) and
 * funnels no workspace reports (e.g. category 1).
 *
 *   evidence                                   assignment
 *   one workspace, nothing else                that workspace (IBOX_UZ, SD_UZ, IBOX_KZ, SD_KZ)
 *   only one non-workspace funnel              NON_DASHBOARD
 *   two or more workspaces/funnels             MIXED          (never forced)
 *   no attributed Deal yet                     UNASSIGNED
 *
 * KZ workspaces are reserved (CRM analytics configured later) but already keep
 * their own spend.
 *
 * Evidence is read fresh on every request: the dashboard's own attribution
 * (Deal → project), plus the tracking D1's lead → Deal → current Bitrix category,
 * which also sees the Deals in funnels the dashboard never syncs. So an ad that
 * gets its first Deal tomorrow is assigned tomorrow, with no re-ingestion.
 * Campaign and ad set spend inside a project are rollups of its assigned ads.
 */
export type SpendAssignment = WorkspaceKey | "NON_DASHBOARD" | "MIXED" | "UNASSIGNED";
export const SPEND_BUCKETS: readonly SpendAssignment[] = [...WORKSPACE_KEYS, "NON_DASHBOARD", "MIXED", "UNASSIGNED"];

export type AdEvidence = { workspaces: Set<WorkspaceKey>; otherCategories: Set<string> };

export function collectAdEvidence(
  attribution: readonly { adId: string | null; workspaceKey: string | null }[],
  trackingCategories: readonly { adId: string | null; categoryId: string | null }[],
): Map<string, AdEvidence> {
  const out = new Map<string, AdEvidence>();
  const entry = (adId: string) => {
    let value = out.get(adId);
    if (!value) { value = { workspaces: new Set(), otherCategories: new Set() }; out.set(adId, value); }
    return value;
  };
  for (const row of attribution) {
    if (!row.adId || !isWorkspaceKey(row.workspaceKey)) continue;
    entry(row.adId).workspaces.add(row.workspaceKey);
  }
  for (const row of trackingCategories) {
    if (!row.adId || !row.categoryId) continue;
    const workspace = workspaceForCategory(row.categoryId);
    if (workspace) entry(row.adId).workspaces.add(workspace);
    else entry(row.adId).otherCategories.add(String(row.categoryId));
  }
  return out;
}

export function classifyAd(evidence: AdEvidence | undefined): SpendAssignment {
  if (!evidence) return "UNASSIGNED";
  const destinations = evidence.workspaces.size + evidence.otherCategories.size;
  if (!destinations) return "UNASSIGNED";
  if (destinations > 1) return "MIXED";
  if (evidence.workspaces.size === 1) return [...evidence.workspaces][0];
  return "NON_DASHBOARD";
}

export function assignAds(evidence: ReadonlyMap<string, AdEvidence>, adIds: Iterable<string>): Map<string, SpendAssignment> {
  const out = new Map<string, SpendAssignment>();
  for (const adId of adIds) out.set(adId, classifyAd(evidence.get(adId)));
  return out;
}

export type BucketTotals = { ads: number; adDays: number; spendByCurrency: Record<string, number>; spendUzs: number | null };

/** Spend per bucket (IBOX_UZ, SD_UZ, IBOX_KZ, SD_KZ, NON_DASHBOARD, MIXED, UNASSIGNED), native minor units and whole UZS. */
export function summarizeAssignment(
  rows: readonly { adId: string; spendMinor: number; currency: string }[],
  assignment: ReadonlyMap<string, SpendAssignment>,
  toUzs: (minor: number, currency: string) => number | null,
): Record<SpendAssignment, BucketTotals> {
  const out = Object.fromEntries(SPEND_BUCKETS.map((bucket) => [bucket, { ads: 0, adDays: 0, spendByCurrency: {}, spendUzs: 0 }])) as Record<SpendAssignment, BucketTotals>;
  const adsSeen = new Map<SpendAssignment, Set<string>>();
  for (const row of rows) {
    const bucket = assignment.get(row.adId) ?? "UNASSIGNED";
    const totals = out[bucket];
    totals.adDays += 1;
    totals.spendByCurrency[row.currency] = (totals.spendByCurrency[row.currency] ?? 0) + row.spendMinor;
    const ads = adsSeen.get(bucket) ?? new Set<string>();
    ads.add(row.adId); adsSeen.set(bucket, ads);
  }
  for (const bucket of SPEND_BUCKETS) {
    out[bucket].ads = adsSeen.get(bucket)?.size ?? 0;
    let uzs: number | null = 0;
    for (const [currency, minor] of Object.entries(out[bucket].spendByCurrency)) {
      const converted = toUzs(minor, currency);
      uzs = converted === null || uzs === null ? null : uzs + converted;
    }
    out[bucket].spendUzs = uzs;
  }
  return out;
}
