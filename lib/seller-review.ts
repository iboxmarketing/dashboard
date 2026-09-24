import type { BackfillSummary, BackfillVerdict } from "./seller-backfill";

/**
 * Presentation model for the admin seller review screen.
 *
 * Pure so the rules the screen shows can be asserted without a DOM: which Deals
 * a human still has to judge, in what order, and what the CONFIRM button is
 * allowed to send.
 */

export type SellerQueueRow = {
  dealId: string;
  title: string;
  wonAt: string | null;
  opportunity: number;
  currencyId: string;
  bitrixUrl: string | null;
  assignedManagerId: string | null;
  assignedManager: string | null;
  observers: { id: string; name: string | null }[];
  postSaleObserverId: string | null;
  postSaleObserver: string | null;
  movedById: string | null;
  movedBy: string | null;
  snapshotSellerId: string | null;
  snapshotSeller: string | null;
  snapshotAttribution: string;
  salesOwnerAtWonId: string | null;
  salesOwnerAtWonName: string | null;
  certification: string | null;
  certificationReason: string | null;
  verdict: BackfillVerdict;
  verdictReason: string;
};

export type SellerAttributionData = {
  canonicalField: string | null;
  configuredSellerField: string | null;
  summary: BackfillSummary;
  coverage: { sales: number; fieldPopulated: number; certified: number; reviewRequired: number; unknown: number };
  queue: SellerQueueRow[];
  queueTruncated: boolean;
  sellers: { id: string; name: string }[];
  confirmations: {
    dealId: string; sellerId: string; sellerName: string | null; confirmedBy: string; confirmedAt: string;
    bitrixWriteStatus?: string | null; bitrixErrorCode?: string | null;
  }[];
  audit: { dealId: string; recordedAt: string; actor: string; action: string }[];
};

/** Newest sale first: a recent unattributed sale is the one somebody remembers. */
export function sortQueue(rows: SellerQueueRow[]) {
  return [...rows].sort((a, b) => String(b.wonAt ?? "").localeCompare(String(a.wonAt ?? "")) || Number(a.dealId) - Number(b.dealId));
}

export function matchesQueueFilters(row: SellerQueueRow, search: string, verdict: "all" | BackfillVerdict) {
  if (verdict !== "all" && row.verdict !== verdict) return false;
  const needle = search.trim().toLocaleLowerCase();
  if (!needle) return true;
  return `${row.dealId} ${row.title} ${row.snapshotSeller ?? ""} ${row.assignedManager ?? ""}`.toLocaleLowerCase().includes(needle);
}

/**
 * Whether CONFIRM may be sent.
 *
 * A seller must be chosen, and it may not be the value the queue already shows
 * as unproven evidence unless the admin picked it deliberately — that check
 * belongs to the human, so the only hard rule here is "an employee was chosen".
 */
export function canConfirm(sellerId: string | null | undefined) {
  return Boolean(sellerId && /^[1-9]\d*$/.test(sellerId));
}

/** Why this Deal is in the queue, in one readable line. */
export function verdictLabel(row: SellerQueueRow) {
  const reasons: Record<string, string> = {
    NO_SELLER_ON_RECORD: "Yozuvda sotuvchi yo‘q",
    NO_CONFIGURED_SELLER_FIELD: "Barqaror sotuvchi maydoni sozlanmagan — eski qiymat isbot emas",
    SNAPSHOT_FIELD_NOT_CORROBORATED: "Snapshot sotuvchisi joriy maydon bilan tasdiqlanmadi",
    MOVER_IS_NOT_SELLER: "Kartani ko‘chirgan xodim sotuvchi emas",
    CURRENT_OWNER_IS_NOT_EVIDENCE: "Joriy mas’ul sotuv dalili emas",
    LEGACY_CALL_EVIDENCE: "Eski qo‘ng‘iroq dalili",
    OUTSIDE_SALES_ROSTER: "Sales ro‘yxatida yo‘q — tekshirish kerak",
    UNKNOWN_USER: "Xodim Bitrix’da topilmadi",
    NO_SELLER: "Sotuvchi aniqlanmadi",
    REJECTED_SELLER_FIELD_CONFIGURED: "Sozlangan maydon sotuvchi dalili sifatida rad etilgan",
  };
  return reasons[row.verdictReason] ?? reasons[row.certificationReason ?? ""] ?? row.verdictReason;
}

export const VERDICT_LABELS: Record<BackfillVerdict, string> = {
  ALREADY_SET: "Maydon to‘ldirilgan",
  OWNER_CONFIRMED: "Tasdiqlangan (owner)",
  SAFE_TO_BACKFILL: "Avtomatik yozishga tayyor",
  REVIEW_REQUIRED: "Tekshiruv kerak",
  UNKNOWN: "Aniqlanmagan",
  NOT_ELIGIBLE: "Mos kelmaydi",
};

export const WRITE_STATUS_LABELS: Record<string, string> = {
  WRITTEN: "Yozildi",
  ALREADY_SET: "Allaqachon to‘g‘ri",
  SKIPPED_NOT_EMPTY: "O‘tkazib yuborildi — maydon bo‘sh emas",
  SKIPPED_NO_FIELD: "Maydon sozlanmagan",
  FAILED: "Xato",
};
