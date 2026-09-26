export type WorkDay = {
  enabled: boolean;
  start: string;
  end: string;
};

export type DashboardSettings = {
  timezone: string;
  schedule: Record<number, WorkDay>;
  holidays: string[];
  slaMinutes: number;
  historyDays: number;
  selectedPipelineIds: string[];
  selectedPipelineNames: string[];
  postSalePipelineIds: string[];
  postSalePipelineNames: string[];
  failureReasonField: string | null;
  failureReasonFieldByPipeline: Record<string, string>;
  marketingChannelField: string | null;
  salesManagerField: string | null;
  /**
   * Canonical seller field: the Bitrix Deal field a robot fills with the
   * Responsible person at the moment the Deal reaches payment
   * (lib/stable-seller-field.ts). Required going forward; null disables it and
   * leaves only legacy evidence, which is never certified on its own.
   */
  salesOwnerAtWonField?: string | null;
  defaultStageLimitHours: number;
  stageLimits: Record<string, number>;
  qualifiedStageIds: string[];
  lowQualityStageIds: string[];
  paymentStageIds: string[];
  closedLostStageIds: string[];
  /** Stages whose closure is a product-fit outcome — see StageSemantics. */
  productFitStageIds: string[];
  /** Where the SLA clock starts; empty means the funnel's first stage — see StageSemantics. */
  distributionStageIds: string[];
  routingReasonPatterns: string[];
  /**
   * Approved Sales staff, for validation only: an attribution naming somebody
   * outside this roster is flagged for review. It never decides who sold, and a
   * seller who later leaves the company keeps their historical sales.
   */
  salesStaffIds?: string[];
  autoSyncMinutes: number;
  dashboardMetricIds: string[];
};

export type PipelineOption = {
  id: string;
  name: string;
};

export type PipelineStageOption = PipelineOption & {
  categoryId: string;
  sort: number;
  semantics: string;
};

export type CurrentStageRecord = {
  dealId: string;
  title: string;
  createdAt: string;
  assignedManagerId: string;
  assignedManager: string;
  categoryId: string;
  pipeline: string;
  stageId: string;
  stage: string;
  /** Canonical Source (SOURCE_ID), so the live Source filter filters this list. */
  sourceId: string;
  source: string;
  stageEnteredAt: string;
  stageAgeHours: number;
  stageLimitHours: number;
  stageOverdue: boolean;
  bitrixUrl: string | null;
};

export type StageReconciliation = {
  liveCount: number;
  cachedCount: number;
  /** Live deal ids also present in the analytics cache — the coverage numerator. */
  matchedCount: number;
  missingCount: number;
  /**
   * Missing live deals split by the SAME window the sync bootstraps from
   * (lib/sync-window.ts). Older-than-window is expected: those deals were never
   * imported. Within-window is a real cache gap and must be investigated.
   */
  missingOlderThanHistoryCount: number;
  missingWithinHistoryCount: number;
  missingOlderThanHistoryDealIds: string[];
  missingWithinHistoryDealIds: string[];
  historyFrom: string | null;
  historyDays: number | null;
  staleCount: number;
  stageMismatchCount: number;
  missingDealIds: string[];
  staleDealIds: string[];
  stageMismatchDealIds: string[];
  fetchedAt: string;
};

export type CrmFieldOption = {
  key: string;
  title: string;
  type: string;
  options: { id: string; value: string }[];
  sampleValue?: string;
  discoverySource?: "DEAL_FIELDS" | "ITEM_FIELDS" | "USERFIELD_LIST" | "DEAL_SAMPLE";
};

export type SyncPhase = "deals" | "stageHistory" | "lookups" | "analytics" | "done";

export type AnalyticsRuntimeDiagnostics = {
  cursor: number;
  attemptedBatchSize: number;
  batchSize: number;
  splitLevel: number;
  retryCount: number;
  minimumAttemptCount: number;
  safeErrorClass: "NONE" | "ANALYTICS_COST_SPLIT" | "ANALYTICS_RUNTIME_SPLIT" | "ANALYTICS_RUNTIME_RETRY";
  state: "attempting" | "completed";
  rawBytes: number;
  historyRows: number;
  historyBytes: number;
  firstDealId: string;
  lastDealId: string;
};

export type SyncProgressState = {
  status: "idle" | "running" | "paused" | "success" | "error";
  phase: SyncPhase | null;
  progress: number;
  message: string | null;
  processed: number;
  total: number;
  stale: boolean;
  selectedPipelines: PipelineOption[];
  scopePipelineId: string | null;
  lastSyncAt: string | null;
  lastFrom: string | null;
  counts: Record<string, number>;
  permissions: Record<string, string>;
  safeError: string | null;
  runId?: string | null;
  analyticsRuntimeDiagnostics?: AnalyticsRuntimeDiagnostics | null;
  stageHistoryDiagnostics?: {
    method: "crm.stagehistory.list";
    lastCode: string;
    lastStatusClass: string | null;
    retryCount: number;
    transientFailures: number;
    permissionFailures: number;
    exhausted: boolean;
    cursor: number;
  } | null;
};

export type CallOutcome =
  | "Ko‘tardi"
  | "Ko‘tarmadi"
  | "Band"
  | "Rad etdi"
  | "Bekor qilindi"
  | "Noto‘g‘ri raqam"
  | "Ulanmadi"
  | "Bloklangan"
  | "Noma’lum";

export type ProcessingSource = "QUALIFICATION_STAGE" | "NO_PROCESSING_EVIDENCE" | "NO_PROCESSING";
export type SlaStatus = "ON_TIME" | "LATE" | "PENDING" | "OVERDUE_UNPROCESSED" | "UNKNOWN_EVIDENCE";
export type CreationPeriod = "WORK_HOURS" | "AFTER_HOURS";
export type SalesStatus = "ACTIVE" | "LOW_QUALITY" | "LOST" | "WON";
/**
 * Why a Deal closed unsuccessfully.
 *
 *   MARKETING     Not Relevant — a marketing-quality rejection.
 *   SALES         an ordinary Sales loss; the only group that is Sotilmadi.
 *   ROUTING       transferred to another brand/team; outside the eligible cohort.
 *   PRODUCT_FIT   a real client our programme does not fit (owner decision,
 *                 2026-09-24). Blames neither Marketing nor Sales: it is not SQL,
 *                 not Not Relevant and not Sotilmadi, stays a Lead inside
 *                 Saralanmagan, and is reported as its own outcome.
 *   NONE          still open, or closed with nothing to classify.
 */
export type LossReasonGroup = "MARKETING" | "SALES" | "ROUTING" | "PRODUCT_FIT" | "NONE";
export type SalesManagerAttribution =
  | "OWNER_CONFIRMED"
  /** An admin named the seller in the dashboard review queue; written back to Bitrix. */
  | "MANUAL_CONFIRMATION"
  /** The canonical robot-written Sales Owner at Won field — see lib/stable-seller-field.ts. */
  | "SALES_OWNER_AT_WON"
  | "CUSTOM_FIELD"
  | "STAGE_MOVER"
  | "POST_SALE_OBSERVER"
  | "CURRENT_RESPONSIBLE"
  | "UNKNOWN";

/**
 * An admin's confirmation from the seller review queue.
 *
 * Stored in D1, written back to the canonical Bitrix field, and read by the
 * analytics builder as an attested per-Deal fact. `priorEvidence` keeps what the
 * record said before, so the audit history survives the correction.
 */
export type SellerConfirmationEvidence = {
  dealId: string;
  sellerId: string;
  sellerName: string | null;
  confirmedBy: string;
  confirmedAt: string;
  priorEvidence?: string | null;
  bitrixWriteStatus?: string | null;
  bitrixWriteAt?: string | null;
  bitrixErrorCode?: string | null;
};

export type StageTimelineEntry = {
  categoryId: string;
  pipeline: string;
  stageId: string;
  stage: string;
  enteredAt: string;
  exitedAt: string | null;
  durationHours: number;
};

export type AnalyticsRecord = {
  analyticsVersion: number;
  dealId: string;
  title: string;
  createdAt: string;
  creationPeriod: CreationPeriod;
  slaStart: string;
  assignedManagerId: string;
  assignedManager: string;
  categoryId: string;
  pipeline: string;
  originCategoryId: string;
  originPipeline: string;
  operationalPipeline: boolean;
  /** Canonical Sales-entry + current-project membership; source/reason never decide it. */
  projectLeadMembership?: "INCLUDED" | "EXCLUDED" | "UNRESOLVED";
  /**
   * Set only on prepared (read-side) records: how membership was established.
   * Never persisted — see `resolveProjectMembership`.
   */
  membershipBasis?: "RECORD" | "LEGACY_OTHER_PROJECT" | "LEGACY_ROUTING" | "LEGACY_NEEDS_REFRESH";
  /**
   * Also read-side only: who this Deal belongs to on a manager scorecard, by its
   * outcome — the certified sale seller for a sale, the roster member responsible
   * for work still in Sales (lib/funnel-owner.ts). Never persisted, so the rule
   * can change without a Full Sync.
   */
  funnelOwnerId?: string | null;
  funnelOwnerName?: string | null;
  funnelOwnerBasis?: import("./funnel-owner").FunnelOwnerBasis;
  /**
   * Where the deal sits *now*, as opposed to which cohort it belongs to.
   * Additive and optional: absent means IN_SCOPE. A definitive move or deletion
   * overrides stored membership; ambiguous lookups leave this field untouched.
   */
  currentScope?: "IN_SCOPE" | "OUT_OF_SCOPE" | "UNAVAILABLE" | "DELETED";
  stageId: string;
  stage: string;
  stageEnteredAt: string;
  stageAgeHours: number;
  stageLimitHours: number;
  stageOverdue: boolean;
  /** Standard Bitrix SOURCE_ID, raw. */
  sourceId: string;
  /** Effective Marketing source — see lib/source-authority.ts. */
  source: string;
  /** SOURCE_ID resolved through the SOURCE dictionary; optional on records older than version 12. */
  rawSource?: string;
  sourceAuthority?: "MARKETING_CHANNEL" | "SOURCE_ID";
  marketingChannel?: string | null;
  salesStatus: SalesStatus;
  qualified: boolean;
  qualifiedAt: string | null;
  qualifiedStageId: string | null;
  qualifiedStage: string | null;
  wonAt: string | null;
  salesCycleHours: number | null;
  opportunity: number;
  currencyId: string;
  lossReason: string;
  lossReasonGroup: LossReasonGroup;
  contactId: string | null;
  companyId: string | null;
  customerKey: string | null;
  duplicateOfDealId: string | null;
  stageTimeline: StageTimelineEntry[];
  salesManagerId: string | null;
  salesManager: string | null;
  salesManagerAttribution: SalesManagerAttribution;
  /** Raw value of the canonical Sales Owner at Won field, stored separately from every other actor. */
  salesOwnerAtWonId?: string | null;
  salesOwnerAtWonName?: string | null;
  /** Whether this attribution may appear on an employee scorecard — see lib/seller-evidence.ts. */
  sellerCertification?: "OWNER_CONFIRMED" | "CERTIFIED" | "REVIEW_REQUIRED" | "UNKNOWN";
  sellerEvidenceReason?: string;
  sellerOutsideRoster?: boolean;
  /**
   * Employee SLA evidence: when the Deal was distributed, when a seller first
   * moved it out of that stage, and the scheduled working minutes between them
   * (lib/business-time.ts businessSlaMinutes). `slaElapsedMinutes` is the calendar
   * span, reported beside the SLA and never as it. All null while the Deal has not
   * been moved yet — a pending SLA is never a completed duration.
   */
  slaStartAt?: string | null;
  slaStopAt?: string | null;
  slaStopStageId?: string | null;
  slaStopStage?: string | null;
  slaBusinessMinutes?: number | null;
  slaElapsedMinutes?: number | null;
  /** Ordinary Sales loss ownership, under the same evidence rules. */
  lostOwnerId?: string | null;
  lostOwnerName?: string | null;
  lostOwnerCertification?: "OWNER_CONFIRMED" | "CERTIFIED" | "REVIEW_REQUIRED" | "UNKNOWN" | null;
  lostOwnerEvidenceReason?: string | null;
  /** Audit trail: the raw actors behind every attribution decision. */
  movedById?: string | null;
  observerIds?: string[];
  postSaleObserverId?: string | null;
  firstCallAt: string | null;
  firstCallActivityId: string | null;
  firstCallManagerId: string | null;
  firstCallManager: string | null;
  firstCallBusinessMinutes: number | null;
  firstCallOutcome: CallOutcome;
  firstCallDuration: number | null;
  outcomeInferred: boolean;
  firstSuccessfulCallAt: string | null;
  firstSuccessfulCallBusinessMinutes: number | null;
  firstStageChangeAt: string | null;
  firstStageChangeTo: string | null;
  firstStageChangeBusinessMinutes: number | null;
  stageChangedBeforeCall: boolean;
  stageAttributionInferred: boolean;
  processingSource: ProcessingSource;
  processingAt: string | null;
  processingBusinessMinutes: number | null;
  slaStatus: SlaStatus;
  outgoingCallCount: number;
  answeredCallCount: number;
  unansweredCallCount: number;
  latestCallOutcome: CallOutcome;
  dataUnavailable: boolean;
  bitrixUrl: string | null;
};

export type ConnectionCheck = {
  configured: boolean;
  domain: string | null;
  bitrix: "ok" | "error" | "unknown";
  deals: "ok" | "error" | "unknown";
  activities: "ok" | "error" | "unknown";
  stageHistory: "ok" | "error" | "unknown";
  managers: "ok" | "error" | "unknown";
  telephony: "ok" | "warning" | "unknown";
  callOutcomes: "ok" | "warning" | "unknown";
  checkedAt: string | null;
  safeMessage: string | null;
};

export type ProviderDiagnostic = {
  key: string;
  providerId: string;
  providerTypeId: string;
  typeId: string;
  direction: string;
  count: number;
  sampleSubject: string;
  mode: "AUTO" | "USE" | "IGNORE";
};
