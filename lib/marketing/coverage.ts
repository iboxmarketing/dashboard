import { stableId } from "./attribution";
import { MARKETING_WORKSPACES, WORKSPACE_KEYS, type WorkspaceKey } from "./workspaces";

/**
 * Attribution coverage per marketing workspace.
 *
 * Activated workspaces (IBOX_UZ, SD_UZ) are measured on the dashboard's own
 * attribution rows. Reserved workspaces (IBOX_KZ, SD_KZ) are not synced by the
 * dashboard yet, so until they are activated their coverage is measured on the
 * Deals the tracking D1 itself delivered into categories 41/33 — a narrower
 * denominator (organic KZ Deals are invisible to it), labelled as such.
 */
export type CoverageEvidence = {
  dealId: string; workspaceKey: string; campaignId: string | null; adsetId: string | null; adId: string | null;
  channel: string; conflict: boolean;
};

export type WorkspaceCoverage = {
  measuredOn: "DASHBOARD_ATTRIBUTION" | "TRACKING_DELIVERED_DEALS";
  deals: number; withCampaignId: number; withAdsetId: number; withAdId: number;
  metaInstantForm: number; website: number; other: number; unknown: number; conflicts: number;
};

export function workspaceCoverage(rows: readonly CoverageEvidence[]): Record<WorkspaceKey, WorkspaceCoverage> {
  const out = Object.fromEntries(MARKETING_WORKSPACES.map((workspace) => [workspace.key, {
    measuredOn: workspace.activated ? "DASHBOARD_ATTRIBUTION" : "TRACKING_DELIVERED_DEALS",
    deals: 0, withCampaignId: 0, withAdsetId: 0, withAdId: 0, metaInstantForm: 0, website: 0, other: 0, unknown: 0, conflicts: 0,
  }])) as Record<WorkspaceKey, WorkspaceCoverage>;
  const seen = new Set<string>();
  for (const row of rows) {
    if (!(WORKSPACE_KEYS as readonly string[]).includes(row.workspaceKey) || seen.has(row.dealId)) continue;
    seen.add(row.dealId);
    const target = out[row.workspaceKey as WorkspaceKey];
    target.deals += 1;
    if (row.campaignId) target.withCampaignId += 1;
    if (row.adsetId) target.withAdsetId += 1;
    if (row.adId) target.withAdId += 1;
    if (row.channel === "META_INSTANT_FORM") target.metaInstantForm += 1;
    else if (row.channel === "WEBSITE") target.website += 1;
    else if (row.channel === "OTHER") target.other += 1;
    else target.unknown += 1;
    if (row.conflict) target.conflicts += 1;
  }
  return out;
}

/** One tracking-delivered Deal (deal_health + its Instant Form lead and/or website submission) as evidence. */
export function trackingCoverageRow(row: {
  deal_id: string; workspace_key: string; lead_id: string | null; mc: string | null; ma: string | null; mad: string | null;
  submission_id: string | null; wc: string | null; wa: string | null; wad: string | null;
}): CoverageEvidence {
  return {
    dealId: String(row.deal_id), workspaceKey: row.workspace_key,
    campaignId: stableId(row.mc) ?? stableId(row.wc), adsetId: stableId(row.ma) ?? stableId(row.wa), adId: stableId(row.mad) ?? stableId(row.wad),
    channel: row.lead_id ? "META_INSTANT_FORM" : row.submission_id ? "WEBSITE" : "UNKNOWN",
    conflict: false,
  };
}
