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

export type ProcessingSource = "OUTGOING_CALL" | "STAGE_CHANGE" | "NO_PROCESSING";
export type SlaStatus = "ON_TIME" | "LATE" | "NO_PROCESSING";
export type CreationPeriod = "WORK_HOURS" | "AFTER_HOURS";

export type AnalyticsRecord = {
  dealId: string;
  title: string;
  createdAt: string;
  creationPeriod: CreationPeriod;
  slaStart: string;
  assignedManagerId: string;
  assignedManager: string;
  categoryId: string;
  pipeline: string;
  stageId: string;
  stage: string;
  sourceId: string;
  source: string;
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

