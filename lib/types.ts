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
  marketingChannelField: string | null;
  salesManagerField: string | null;
  defaultStageLimitHours: number;
  stageLimits: Record<string, number>;
  qualifiedStageIds: string[];
  lowQualityStageIds: string[];
  paymentStageIds: string[];
  closedLostStageIds: string[];
  routingReasonPatterns: string[];
  autoSyncMinutes: number;
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
  stageEnteredAt: string;
  stageAgeHours: number;
  stageLimitHours: number;
  stageOverdue: boolean;
  bitrixUrl: string | null;
};

export type StageReconciliation = {
  liveCount: number;
  cachedCount: number;
  missingCount: number;
  staleCount: number;
  stageMismatchCount: number;
  missingDealIds: string[];
  staleDealIds: string[];
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

export type SyncPhase = "deals" | "activities" | "stageHistory" | "telephony" | "lookups" | "analytics" | "done";

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
export type LossReasonGroup = "MARKETING" | "SALES" | "ROUTING" | "NONE";
export type SalesManagerAttribution = "CUSTOM_FIELD" | "FIRST_CALL" | "STAGE_MOVER" | "CURRENT_RESPONSIBLE" | "UNKNOWN";

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
  stageId: string;
  stage: string;
  stageEnteredAt: string;
  stageAgeHours: number;
  stageLimitHours: number;
  stageOverdue: boolean;
  sourceId: string;
  source: string;
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
