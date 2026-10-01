/**
 * Sales projects: IBOX and Sales Doctor, as isolated analytics workspaces.
 *
 * One Bitrix portal carries both products, and the raw Deal truth is shared: a
 * Deal is one Bitrix record whichever funnel it sits in. What differs is the
 * INTERPRETATION — which funnel is Sales, which is post-sale, which stage means
 * SQL, Not Relevant, Sales Lost or a sale, who is on the Sales roster, which field
 * freezes the seller, which stage starts the SLA clock. All of that is a
 * project's configuration, and none of it may leak into the other project.
 *
 * Membership follows the Deal's CURRENT project family (owner decision,
 * 2026-10-01): a Deal in 3 or 13 is IBOX, a Deal in 5 or 17 is Sales Doctor. A
 * client moved from one product to the other leaves the first project's current
 * population and joins the second's, and returns if moved back. No Deal counts in
 * both current populations at once, and stage history is kept for audit only.
 *
 * This module is the ONLY place a category number belongs to a project. Nothing
 * else may assume CATEGORY_ID 3.
 */
import { defaultSettings } from "./business-time";
import type { DashboardSettings } from "./types";

export const PROJECT_KEYS = ["IBOX", "SALES_DOCTOR"] as const;
export type ProjectKey = (typeof PROJECT_KEYS)[number];

export type SalesProject = {
  key: ProjectKey;
  /** The workspace's own URL segment: `/ibox`, `/sales-doctor`. */
  slug: string;
  name: string;
  salesCategoryId: string;
  salesCategoryName: string;
  postSaleCategoryId: string;
  postSaleCategoryName: string;
  /**
   * Where this project's settings live in `app_settings`. IBOX keeps the key it
   * has always used, so the accepted IBOX configuration is read unchanged — no
   * migration, no reinterpretation.
   */
  settingsKey: string;
  /**
   * Whether the project has a product-fit outcome ("Klient lekin programma
   * nepodxodit"). IBOX does; Sales Doctor does not (owner decision, 2026-10-01),
   * so its screens never show an IBOX-only outcome as if it applied.
   */
  hasProductFit: boolean;
};

export const SALES_PROJECTS: Record<ProjectKey, SalesProject> = {
  IBOX: {
    key: "IBOX", slug: "ibox", name: "IBOX",
    salesCategoryId: "3", salesCategoryName: "IBOX sales",
    postSaleCategoryId: "13", postSaleCategoryName: "IBOX Обучение/Сопровождение",
    settingsKey: "dashboard",
    hasProductFit: true,
  },
  SALES_DOCTOR: {
    key: "SALES_DOCTOR", slug: "sales-doctor", name: "Sales Doctor",
    salesCategoryId: "5", salesCategoryName: "Sales Doctor",
    postSaleCategoryId: "17", postSaleCategoryName: "SD Обучение/Сопровождение",
    settingsKey: "dashboard:SALES_DOCTOR",
    hasProductFit: false,
  },
};

/** IBOX is what every request meant before projects existed. */
export const DEFAULT_PROJECT: ProjectKey = "IBOX";

export function isProjectKey(value: unknown): value is ProjectKey {
  return typeof value === "string" && (PROJECT_KEYS as readonly string[]).includes(value);
}

/** The project a request names, or IBOX when it names none — never a guess between two. */
export function parseProjectKey(value: unknown): ProjectKey | null {
  if (value === null || value === undefined || value === "") return DEFAULT_PROJECT;
  const text = String(value).trim().toUpperCase().replace(/-/g, "_");
  return isProjectKey(text) ? text : null;
}

export function projectBySlug(slug: unknown): SalesProject | null {
  return Object.values(SALES_PROJECTS).find((project) => project.slug === String(slug ?? "")) ?? null;
}

/** The project family a Bitrix category belongs to, or null for any other funnel. */
export function projectForCategory(categoryId: unknown): ProjectKey | null {
  const id = String(categoryId ?? "").trim();
  for (const project of Object.values(SALES_PROJECTS)) {
    if (project.salesCategoryId === id || project.postSaleCategoryId === id) return project.key;
  }
  return null;
}

export function projectCategoryIds(project: ProjectKey) {
  const { salesCategoryId, postSaleCategoryId } = SALES_PROJECTS[project];
  return [salesCategoryId, postSaleCategoryId];
}

/**
 * Does this stage id belong to one of the project's funnels?
 *
 * Bitrix stage ids carry their category (`C5:WON`); category 0 uses bare ids and
 * belongs to neither project.
 */
export function stageBelongsToProject(stageId: string, project: ProjectKey) {
  const match = /^C(\d+):/.exec(String(stageId));
  return Boolean(match) && projectCategoryIds(project).includes(match![1]);
}

/**
 * The owner-approved Sales Doctor roster (2026-10-01), resolved to Bitrix user
 * ids from the synced user dictionary. Keyed by id, never by display name.
 *
 * "Abubakr Rahimov" matches two users (both "Abubakir Rahimov", ids 223 and
 * 12565). The owner confirmed they are ONE person: 12565 is his current account,
 * 223 his earlier one (see PROJECT_SELLER_IDENTITY).
 */
export const SALES_DOCTOR_ROSTER: readonly { id: string; name: string; bitrixName: string }[] = [
  { id: "235", name: "Abdulla Norboyev", bitrixName: "Abdulla Norboyev" },
  { id: "12565", name: "Abubakr Rahimov", bitrixName: "Abubakir Rahimov" },
  { id: "225", name: "Jasur Shadiev", bitrixName: "Jasur Shadieev" },
  { id: "229", name: "Ikrom Tojiev", bitrixName: "Ikrom Tojiyev" },
  { id: "203", name: "Humoyun Toirjonov", bitrixName: "Humoyun Toirjonov" },
  { id: "13121", name: "Behruz Abdulazizov", bitrixName: "Behruz Abdulazizov" },
];

export type SellerIdentityConfig = {
  /** Roster name → the owner-chosen Bitrix id, for a name the directory cannot resolve alone. */
  pinnedIds: Readonly<Record<string, string>>;
  /** An old Bitrix account → the same person's current account. Never two manager rows. */
  aliases: Readonly<Record<string, string>>;
  /**
   * Former sellers the owner confirmed. They keep historical sales and revenue
   * but are never on the roster, so they receive no current workload.
   */
  historicalSellers: readonly { id: string; name: string }[];
};

/**
 * Owner decisions about seller identity (2026-10-01, "OWNER CONFIRMATION — SALES
 * DOCTOR SELLER IDENTITY"). IBOX has none.
 */
export const PROJECT_SELLER_IDENTITY: Record<ProjectKey, SellerIdentityConfig> = {
  IBOX: { pinnedIds: {}, aliases: {}, historicalSellers: [] },
  SALES_DOCTOR: {
    pinnedIds: { "Abubakr Rahimov": "12565" },
    aliases: { "223": "12565" },
    historicalSellers: [{ id: "199", name: "Otabek Sulaymonov" }],
  },
};

/** The one reporting identity for a Bitrix user id within a project. */
export function canonicalSellerId(project: ProjectKey | null | undefined, id: string): string {
  if (!project || !id) return id;
  return PROJECT_SELLER_IDENTITY[project].aliases[id] ?? id;
}

export function historicalSellerIds(project: ProjectKey): Set<string> {
  return new Set(PROJECT_SELLER_IDENTITY[project].historicalSellers.map((seller) => seller.id));
}

/**
 * "SD Sales Owner at Won" (owner-created, 2026-10-01). A Bitrix robot on Sales
 * Doctor's ЕСТЬ ЗАПУСК! stage writes the current Responsible into it when it is
 * empty — before the transfer to category 17 and before any onboarding
 * reassignment. It is a separate field from IBOX's `UF_CRM_1790230512`, so neither
 * product's automation can overwrite the other's evidence.
 */
export const SALES_DOCTOR_OWNER_AT_WON_FIELD = "UF_CRM_1790786031";

/** Sales Doctor's approved stage mapping, from Bitrix `DEAL_STAGE_5`. */
export const SALES_DOCTOR_STAGES = {
  distribution: "C5:NEW", // РАСПРЕДЕЛЁННЫЕ СДЕЛКИ
  sqlStart: "C5:PREPAYMENT_INVOICE", // ОБРАБОТКА
  won: "C5:WON", // ЕСТЬ ЗАПУСК!
  salesLost: "C5:LOSE", // ЗАКРЫТО И НЕ РЕАЛИЗОВАНО
  notRelevant: "C5:UC_X51N7T", // Not Relevant (Marketing)
  /** The only stages that are Saralanmagan (owner rule, 2026-10-01). */
  unclassified: ["C5:NEW", "C5:PREPARATION"], // РАСПРЕДЕЛЁННЫЕ СДЕЛКИ, НЕ ОТВЕЧАЕТ
} as const;

export type StageQuality = {
  salesStatus: "ACTIVE" | "LOW_QUALITY" | "LOST" | "WON";
  lossReasonGroup: "MARKETING" | "SALES" | "NONE";
  qualified: boolean;
};

/**
 * Sales Doctor quality from the Deal's CURRENT stage (owner rule, 2026-10-01).
 *
 *   РАСПРЕДЕЛЁННЫЕ СДЕЛКИ, НЕ ОТВЕЧАЕТ   Saralanmagan
 *   Not Relevant (Marketing)              Not Relevant — never SQL
 *   ЗАКРЫТО И НЕ РЕАЛИЗОВАНО              SQL and Sales Lost
 *   ЕСТЬ ЗАПУСК!, or now in category 17   SQL and a sale
 *   every other category-5 stage          SQL, still open
 *
 * The failure reason never decides any of these; it stays a diagnostic. A Won
 * visit in the history that the Deal has since left (back to an open stage in
 * category 5) is not a sale. Null for IBOX, and for a Deal that has left both
 * Sales Doctor funnels: those keep the general rules.
 */
export function currentStageQuality(project: ProjectKey | null | undefined, categoryId: string, stageId: string): StageQuality | null {
  if (project !== "SALES_DOCTOR") return null;
  const registry = SALES_PROJECTS.SALES_DOCTOR;
  if (categoryId === registry.postSaleCategoryId) return { salesStatus: "WON", lossReasonGroup: "NONE", qualified: true };
  if (categoryId !== registry.salesCategoryId) return null;
  if (stageId === SALES_DOCTOR_STAGES.won) return { salesStatus: "WON", lossReasonGroup: "NONE", qualified: true };
  if (stageId === SALES_DOCTOR_STAGES.notRelevant) return { salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING", qualified: false };
  if (stageId === SALES_DOCTOR_STAGES.salesLost) return { salesStatus: "LOST", lossReasonGroup: "SALES", qualified: true };
  if ((SALES_DOCTOR_STAGES.unclassified as readonly string[]).includes(stageId)) return { salesStatus: "ACTIVE", lossReasonGroup: "NONE", qualified: false };
  return { salesStatus: "ACTIVE", lossReasonGroup: "NONE", qualified: true };
}

/** Mon–Fri 10:00–18:00 Asia/Tashkent, as approved for Sales Doctor. */
const WORKDAY = { enabled: true, start: "10:00", end: "18:00" };
const OFFDAY = { enabled: false, start: "10:00", end: "18:00" };

/**
 * Sales Doctor's starting configuration.
 *
 * Only company-wide facts are taken from the IBOX settings, once, at seeding: the
 * holiday calendar, the Marketing Kanali field (one Deal field for the whole
 * portal) and the sync history window. After that the two configurations are
 * independent — changing one never changes the other.
 */
export function seedSalesDoctorSettings(companyWide: Pick<DashboardSettings, "holidays" | "marketingChannelField" | "historyDays" | "slaMinutes" | "failureReasonFieldByPipeline">): DashboardSettings {
  const project = SALES_PROJECTS.SALES_DOCTOR;
  return {
    ...defaultSettings,
    timezone: "Asia/Tashkent",
    schedule: { 0: OFFDAY, 1: WORKDAY, 2: WORKDAY, 3: WORKDAY, 4: WORKDAY, 5: WORKDAY, 6: OFFDAY },
    holidays: [...companyWide.holidays],
    slaMinutes: companyWide.slaMinutes,
    historyDays: companyWide.historyDays,
    selectedPipelineIds: [project.salesCategoryId],
    selectedPipelineNames: [project.salesCategoryName],
    postSalePipelineIds: [project.postSaleCategoryId],
    postSalePipelineNames: [project.postSaleCategoryName],
    qualifiedStageIds: [SALES_DOCTOR_STAGES.sqlStart],
    lowQualityStageIds: [SALES_DOCTOR_STAGES.notRelevant],
    paymentStageIds: [SALES_DOCTOR_STAGES.won],
    closedLostStageIds: [SALES_DOCTOR_STAGES.salesLost],
    // Sales Doctor has no product-fit outcome (owner decision, 2026-10-01).
    productFitStageIds: [],
    distributionStageIds: [SALES_DOCTOR_STAGES.distribution],
    salesStaffIds: SALES_DOCTOR_ROSTER.map((seller) => seller.id),
    salesOwnerAtWonField: SALES_DOCTOR_OWNER_AT_WON_FIELD,
    salesManagerField: null,
    marketingChannelField: companyWide.marketingChannelField,
    failureReasonField: null,
    failureReasonFieldByPipeline: companyWide.failureReasonFieldByPipeline?.[project.salesCategoryId]
      ? { [project.salesCategoryId]: companyWide.failureReasonFieldByPipeline[project.salesCategoryId] }
      : {},
    autoSyncMinutes: 0,
  };
}

/**
 * The project's funnels are the registry's, whatever an older settings row says.
 * A project cannot be pointed at the other project's category.
 */
export function withProjectPipelines(settings: DashboardSettings, project: ProjectKey): DashboardSettings {
  const registry = SALES_PROJECTS[project];
  return {
    ...settings,
    selectedPipelineIds: [registry.salesCategoryId],
    selectedPipelineNames: [settings.selectedPipelineNames?.[settings.selectedPipelineIds.indexOf(registry.salesCategoryId)] || registry.salesCategoryName],
    postSalePipelineIds: [registry.postSaleCategoryId],
    postSalePipelineNames: [settings.postSalePipelineNames?.[settings.postSalePipelineIds.indexOf(registry.postSaleCategoryId)] || registry.postSaleCategoryName],
  };
}

/**
 * Which project population a stored record belongs to.
 *
 * A record built by the project-aware builder says so itself. A record written
 * before projects existed was built with the one global configuration there was
 * — IBOX's — so it is trusted only as an IBOX-family record; a legacy Sales
 * Doctor record was interpreted with IBOX's roster, seller field and stage rules
 * and belongs to no population until Sales Doctor rebuilds it.
 */
export function recordProject(row: { projectKey?: ProjectKey | null; categoryId?: unknown; originCategoryId?: unknown }): ProjectKey | null {
  if (row.projectKey !== undefined) return row.projectKey ?? null;
  return dealProjectFamily(row.categoryId, row.originCategoryId) === "IBOX" ? "IBOX" : null;
}

/**
 * The project family a Deal belongs to now.
 *
 * Its current category decides whenever that category is one of a project's
 * funnels: moving between IBOX and Sales Doctor moves the Deal between
 * populations (owner decision, 2026-10-01). A Deal that has left BOTH families —
 * into a churn-risk or any other funnel — still belongs to the family it came
 * from, which is what keeps the accepted rule "a proven sale keeps its Period Sale
 * even if the Deal later moves" true for a sold client moved elsewhere.
 */
export function dealProjectFamily(currentCategoryId: unknown, originCategoryId: unknown): ProjectKey | null {
  return projectForCategory(currentCategoryId) ?? projectForCategory(originCategoryId);
}

/** Legacy records of this project's family that still await a project-aware rebuild. */
export function awaitsProjectRebuild(row: { projectKey?: ProjectKey | null; categoryId?: unknown; originCategoryId?: unknown }, project: ProjectKey) {
  return row.projectKey === undefined && dealProjectFamily(row.categoryId, row.originCategoryId) === project && recordProject(row) !== project;
}

const STAGE_LIST_KEYS = [
  "qualifiedStageIds", "lowQualityStageIds", "paymentStageIds", "closedLostStageIds", "productFitStageIds", "distributionStageIds",
] as const;

/**
 * A settings object with every stage list limited to this project's own funnels,
 * and its funnels pinned to the registry. Applied on SAVE: a project's rules can
 * then only ever name its own stages, so editing one project cannot change what
 * the other project's Deals mean.
 */
export function scopeSettingsToProject(settings: DashboardSettings, project: ProjectKey): DashboardSettings {
  const scoped = { ...withProjectPipelines(settings, project) };
  for (const key of STAGE_LIST_KEYS) {
    scoped[key] = (settings[key] ?? []).filter((stageId) => stageBelongsToProject(stageId, project));
  }
  scoped.failureReasonFieldByPipeline = Object.fromEntries(Object.entries(settings.failureReasonFieldByPipeline ?? {})
    .filter(([categoryId]) => projectCategoryIds(project).includes(String(categoryId))));
  scoped.stageLimits = Object.fromEntries(Object.entries(settings.stageLimits ?? {})
    .filter(([stageId]) => stageBelongsToProject(stageId, project) || !/^C\d+:/.test(stageId)));
  return scoped;
}
