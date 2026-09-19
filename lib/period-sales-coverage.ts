/**
 * Extra Deal-discovery streams for period Sales.
 *
 * The historical Lead import is deliberately DATE_CREATE-based. These queries
 * complement it with trustworthy sale events, so an older Lead paid inside the
 * sync window reaches the same raw -> history -> analytics pipeline without
 * changing cohort membership.
 */

export type DealDiscoveryScope = "main" | "paymentHistory" | "currentPayment" | "postSale";

type DiscoveryInput = {
  scope: Exclude<DealDiscoveryScope, "main">;
  salesCategoryIds: string[];
  postSaleCategoryIds: string[];
  paymentStageIds: string[];
  fromIso: string;
  toIso: string;
  dealSelect: string[];
};

export type PeriodSalesDiscoveryRequest = {
  kind: "history" | "deals";
  method: "crm.stagehistory.list" | "crm.deal.list";
  params: Record<string, unknown>;
  idField: "OWNER_ID" | "ID";
};

function exactOrIn(field: string, values: string[]) {
  return values.length === 1 ? { [field]: values[0] } : { [`@${field}`]: values };
}

export function nextDealDiscoveryScope(
  current: DealDiscoveryScope,
  input: { hasPaymentStages: boolean; hasPostSale: boolean },
): Exclude<DealDiscoveryScope, "main"> | null {
  if (current === "main") {
    if (input.hasPaymentStages) return "paymentHistory";
    return input.hasPostSale ? "postSale" : null;
  }
  if (current === "paymentHistory") {
    if (input.hasPaymentStages) return "currentPayment";
    return input.hasPostSale ? "postSale" : null;
  }
  if (current === "currentPayment") return input.hasPostSale ? "postSale" : null;
  return null;
}

export function buildPeriodSalesDiscoveryRequest(input: DiscoveryInput): PeriodSalesDiscoveryRequest | null {
  const window = { ">=CREATED_TIME": input.fromIso, "<=CREATED_TIME": input.toIso };

  if (input.scope === "paymentHistory") {
    if (!input.salesCategoryIds.length || !input.paymentStageIds.length) return null;
    return {
      kind: "history",
      method: "crm.stagehistory.list",
      idField: "OWNER_ID",
      params: {
        entityTypeId: 2,
        order: { ID: "ASC" },
        filter: {
          ...exactOrIn("CATEGORY_ID", input.salesCategoryIds),
          ...exactOrIn("STAGE_ID", input.paymentStageIds),
          ...window,
        },
        select: ["ID", "OWNER_ID", "CATEGORY_ID", "STAGE_ID", "TYPE_ID", "CREATED_TIME"],
      },
    };
  }

  if (input.scope === "currentPayment") {
    if (!input.salesCategoryIds.length || !input.paymentStageIds.length) return null;
    return {
      kind: "deals",
      method: "crm.deal.list",
      idField: "ID",
      params: {
        order: { MOVED_TIME: "ASC", ID: "ASC" },
        filter: {
          ...exactOrIn("CATEGORY_ID", input.salesCategoryIds),
          ...exactOrIn("STAGE_ID", input.paymentStageIds),
          ">=MOVED_TIME": input.fromIso,
          "<=MOVED_TIME": input.toIso,
        },
        select: input.dealSelect,
      },
    };
  }

  if (!input.postSaleCategoryIds.length) return null;
  return {
    kind: "history",
    method: "crm.stagehistory.list",
    idField: "OWNER_ID",
    params: {
      entityTypeId: 2,
      order: { ID: "ASC" },
      filter: {
        ...exactOrIn("CATEGORY_ID", input.postSaleCategoryIds),
        TYPE_ID: 5,
        ...window,
      },
      select: ["ID", "OWNER_ID", "CATEGORY_ID", "STAGE_ID", "TYPE_ID", "CREATED_TIME"],
    },
  };
}

export function uniqueDiscoveryIds(rows: Record<string, unknown>[], field: "OWNER_ID" | "ID") {
  return [...new Set(rows.map((row) => String(row[field] ?? "").trim()).filter(Boolean))];
}
