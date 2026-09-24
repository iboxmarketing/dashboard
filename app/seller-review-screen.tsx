"use client";

import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, ShieldCheck, UserCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { SelectInput, TextInput } from "./ui/form";
import { authFetch } from "@/lib/auth-fetch";
import type { BackfillVerdict } from "@/lib/seller-backfill";
import {
  canConfirm, matchesQueueFilters, sortQueue, verdictLabel, VERDICT_LABELS, WRITE_STATUS_LABELS,
  type SellerAttributionData, type SellerQueueRow,
} from "@/lib/seller-review";

/**
 * Admin seller review.
 *
 * Every sale whose seller is not proven appears here with the evidence that
 * exists — the current assignee, the observers, who moved the card, the frozen
 * legacy snapshot — and the reason none of it counts. An admin names the seller;
 * only then is anything written, and the write goes to Bitrix first
 * (`UF_CRM_1790230512`) so the CRM and the dashboard can never disagree.
 *
 * The legacy backfill lives on the same screen because it answers the other half
 * of the same question: which old sales already carry deterministic proof and
 * therefore need no human at all.
 */

type Money = { amount: number; currency: string };
const money = ({ amount, currency }: Money) => `${Math.round(amount).toLocaleString("uz-UZ")} ${currency || "UZS"}`;
const day = (value: string | null) => (value ? new Date(value).toLocaleString("uz-UZ", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—");

type Feedback = { dealId: string; ok: boolean; message: string };

function EvidenceCell({ row }: { row: SellerQueueRow }) {
  const observers = row.observers.filter((entry) => entry.id);
  return <div className="seller-evidence">
    <span>Joriy mas’ul: <strong>{row.assignedManager ?? "—"}</strong></span>
    <span>Ko‘chirgan: <strong>{row.movedBy ?? "—"}</strong></span>
    <span>Observer: <strong>{observers.length ? observers.map((entry) => entry.name ?? entry.id).join(", ") : "—"}</strong></span>
    <span>Eski snapshot: <strong>{row.snapshotSeller ?? "—"}</strong> <small>{row.snapshotAttribution}</small></span>
  </div>;
}

export function SellerReviewTable({ rows, sellers, busyDealId, feedback, onConfirm }: {
  rows: SellerQueueRow[];
  sellers: { id: string; name: string }[];
  busyDealId: string | null;
  feedback: Feedback | null;
  onConfirm: (dealId: string, sellerId: string) => void;
}) {
  const [chosen, setChosen] = useState<Record<string, string>>({});
  if (!rows.length) {
    return <div className="notice page-notice"><CheckCircle2 size={17} />Tekshiruv kutayotgan sotuv yo‘q.</div>;
  }
  return <div className="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Deal</th><th>Sotuv sanasi</th><th>Summa</th><th>Dalillar</th><th>Nega tasdiqlanmagan</th><th>Sotuvchi</th><th aria-label="Amal" />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const selected = chosen[row.dealId] ?? "";
          const busy = busyDealId === row.dealId;
          return <tr key={row.dealId}>
            <td>
              {row.bitrixUrl
                ? <a href={row.bitrixUrl} target="_blank" rel="noreferrer">#{row.dealId}</a>
                : <span>#{row.dealId}</span>}
              <small className="card-note">{row.title}</small>
            </td>
            <td>{day(row.wonAt)}</td>
            <td>{money({ amount: row.opportunity, currency: row.currencyId })}</td>
            <td><EvidenceCell row={row} /></td>
            <td>
              <span className="pill">{VERDICT_LABELS[row.verdict]}</span>
              <small className="card-note">{verdictLabel(row)}</small>
            </td>
            <td>
              <SelectInput value={selected} aria-label={`Deal ${row.dealId} sotuvchisi`}
                onChange={(event) => setChosen((current) => ({ ...current, [row.dealId]: event.target.value }))}>
                <option value="">Tanlang…</option>
                {sellers.map((seller) => <option key={seller.id} value={seller.id}>{seller.name}</option>)}
              </SelectInput>
              {feedback?.dealId === row.dealId && <small className={feedback.ok ? "card-note" : "form-error"}>{feedback.message}</small>}
            </td>
            <td>
              <button type="button" className="ghost" disabled={!canConfirm(selected) || busy}
                onClick={() => onConfirm(row.dealId, selected)}>
                {busy ? <Loader2 size={15} className="spin" /> : <UserCheck size={15} />}Tasdiqlash
              </button>
            </td>
          </tr>;
        })}
      </tbody>
    </table>
  </div>;
}

export function SellerReviewScreen() {
  const [data, setData] = useState<SellerAttributionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [search, setSearch] = useState("");
  const [verdict, setVerdict] = useState<"all" | BackfillVerdict>("all");
  const [busyDealId, setBusyDealId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [plan, setPlan] = useState<{ dealId: string; sellerName: string | null; evidenceType: string | null; reason: string }[] | null>(null);
  const [writeResults, setWriteResults] = useState<{ dealId: string; status: string; errorCode: string | null }[] | null>(null);
  const [backfillBusy, setBackfillBusy] = useState(false);
  const [backfillError, setBackfillError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const response = await authFetch("/api/admin/seller-attribution", { cache: "no-store" });
        const payload = await response.json().catch(() => null) as (SellerAttributionData & { error?: string }) | null;
        if (cancelled) return;
        if (!response.ok) { setData(null); setError(payload?.error ?? "Ma’lumot yuklanmadi"); return; }
        setData(payload as SellerAttributionData); setError(null);
      } catch {
        if (!cancelled) { setData(null); setError("Serverga ulanmadi. Qayta urinib ko‘ring."); }
      } finally { if (!cancelled) setLoading(false); }
    };
    void run();
    return () => { cancelled = true; };
  }, [reload]);

  const rows = useMemo(
    () => (data ? sortQueue(data.queue).filter((row) => matchesQueueFilters(row, search, verdict)) : []),
    [data, search, verdict],
  );

  const confirmSeller = useCallback(async (dealId: string, sellerId: string) => {
    setBusyDealId(dealId); setFeedback(null);
    try {
      const response = await authFetch("/api/admin/seller-attribution", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "confirm", dealId, sellerId }),
      });
      const payload = await response.json().catch(() => null) as { error?: string; status?: string; certified?: boolean } | null;
      if (!response.ok || !payload?.certified) {
        setFeedback({ dealId, ok: false, message: payload?.error ?? "Tasdiqlanmadi" });
        return;
      }
      setFeedback({ dealId, ok: true, message: "Bitrix’ga yozildi va tasdiqlandi" });
      setReload((token) => token + 1);
    } catch {
      setFeedback({ dealId, ok: false, message: "Serverga ulanmadi" });
    } finally { setBusyDealId(null); }
  }, []);

  const runBackfill = useCallback(async (mode: "dry-run" | "apply") => {
    setBackfillBusy(true); setBackfillError(null);
    if (mode === "apply") setPlan(null); else setWriteResults(null);
    try {
      const response = await authFetch("/api/admin/seller-attribution", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "backfill", mode }),
      });
      const payload = await response.json().catch(() => null) as {
        error?: string; plan?: { dealId: string; sellerName: string | null; evidenceType: string | null; reason: string }[];
        results?: { dealId: string; status: string; errorCode: string | null }[];
      } | null;
      if (!response.ok) { setBackfillError(payload?.error ?? "Backfill bajarilmadi"); return; }
      if (mode === "dry-run") setPlan(payload?.plan ?? []);
      else { setWriteResults(payload?.results ?? []); setReload((token) => token + 1); }
    } catch {
      setBackfillError("Serverga ulanmadi");
    } finally { setBackfillBusy(false); }
  }, []);

  if (loading && !data) return <div className="notice page-notice"><Loader2 size={17} className="spin" />Sotuvchi atributsiyasi yuklanmoqda…</div>;
  if (error) return <div className="notice warning page-notice"><AlertTriangle size={17} />{error}</div>;
  if (!data) return null;

  const { coverage, summary } = data;
  return <>
    <div className="page-title"><div>
      <p className="eyebrow">ADMIN</p><h1>Sotuvchi tasdiqlash</h1>
      <p>Sotuvchi dalili faqat Bitrix’dagi <strong>Sales Owner at Won</strong> maydonidan yoki aniq tasdiqdan olinadi. Tasdiqlanmagan sotuv hech kimning hisobiga kirmaydi.</p>
    </div><div className="period-summary">
      <ShieldCheck size={17} /><span>{data.canonicalField ?? "maydon sozlanmagan"}</span>
      <strong>{coverage.certified} / {coverage.sales} tasdiqlangan</strong>
    </div></div>

    {!data.canonicalField && <div className="notice warning page-notice"><AlertTriangle size={17} />
      Sales Owner at Won maydoni sozlanmagan — Sozlamalar bo‘limida <code>UF_CRM_1790230512</code> ni kiriting.
    </div>}

    <section className="panel">
      <SellerReviewHeader title="Qamrov" subtitle="Sotuv soni bo‘yicha: maydon to‘ldirilgan, tasdiqlangan va tekshiruv kutayotgan" />
      <div className="quality-grid">
        <div><span>Sotuvlar</span><strong>{coverage.sales}</strong><small>WON + sotuv sanasi</small></div>
        <div><span>Maydon to‘ldirilgan</span><strong>{coverage.fieldPopulated}</strong><small>Sales Owner at Won</small></div>
        <div><span>Tasdiqlangan</span><strong>{coverage.certified}</strong><small>Faqat shu sotuvlar xodim hisobiga kiradi</small></div>
        <div><span>Tekshiruv kerak</span><strong>{coverage.reviewRequired}</strong><small>Dalil yetarli emas</small></div>
        <div><span>Aniqlanmagan</span><strong>{coverage.unknown}</strong><small>Sotuvchi dalili yo‘q</small></div>
      </div>
    </section>

    <section className="panel">
      <SellerReviewHeader title="Eski sotuvlar uchun backfill"
        subtitle="Faqat deterministik dalil avtomatik yoziladi: owner tasdiqlagan yoki allaqachon sertifikatlangan sotuvlar" />
      <div className="quality-grid">
        <div><span>Maydon to‘ldirilgan</span><strong>{summary.alreadySet}</strong></div>
        <div><span>Owner tasdiqlagan</span><strong>{summary.ownerConfirmed}</strong></div>
        <div><span>Avtomatik yozishga tayyor</span><strong>{summary.safeToBackfill}</strong></div>
        <div><span>Tekshiruv kerak</span><strong>{summary.reviewRequired}</strong></div>
        <div><span>Aniqlanmagan</span><strong>{summary.unknown}</strong></div>
      </div>
      <div className="save-bar-actions seller-backfill-actions">
        <button type="button" className="ghost" disabled={backfillBusy} onClick={() => void runBackfill("dry-run")}>
          {backfillBusy ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}Dry-run
        </button>
        <button type="button" disabled={backfillBusy || !summary.writable || !data.canonicalField}
          onClick={() => { if (window.confirm(`${summary.writable} ta Deal uchun Bitrix maydoni to‘ldiriladi. Davom etamizmi?`)) void runBackfill("apply"); }}>
          <ShieldCheck size={15} />Tasdiqlangan {summary.writable} ta yozuvni qo‘llash
        </button>
      </div>
      {backfillError && <div className="notice warning page-notice"><AlertTriangle size={17} />{backfillError}</div>}
      {plan && <div className="table-wrap"><table>
        <thead><tr><th>Deal</th><th>Sotuvchi</th><th>Dalil</th><th>Sabab</th></tr></thead>
        <tbody>{plan.length
          ? plan.map((entry) => <tr key={entry.dealId}><td>#{entry.dealId}</td><td>{entry.sellerName ?? "—"}</td><td>{entry.evidenceType ?? "—"}</td><td>{entry.reason}</td></tr>)
          : <tr><td colSpan={4}>Avtomatik yozish uchun deterministik dalilli Deal yo‘q.</td></tr>}
        </tbody></table></div>}
      {writeResults && <div className="table-wrap"><table>
        <thead><tr><th>Deal</th><th>Holat</th><th>Xato kodi</th></tr></thead>
        <tbody>{writeResults.map((result) => <tr key={result.dealId}>
          <td>#{result.dealId}</td><td>{WRITE_STATUS_LABELS[result.status] ?? result.status}</td><td>{result.errorCode ?? "—"}</td>
        </tr>)}</tbody></table></div>}
    </section>

    <section className="panel">
      <SellerReviewHeader title="Tekshiruv navbati" subtitle="Tasdiqlash Bitrix’ga yoziladi, keyin dashboard yangilanadi" action={
        <button type="button" className="ghost" onClick={() => setReload((token) => token + 1)}><RefreshCw size={15} />Yangilash</button>
      } />
      <div className="seller-review-filters">
        <TextInput placeholder="Deal ID, nom yoki xodim" value={search} onChange={(event) => setSearch(event.target.value)} />
        <SelectInput value={verdict} aria-label="Holat" onChange={(event) => setVerdict(event.target.value as "all" | BackfillVerdict)}>
          <option value="all">Barchasi</option>
          <option value="REVIEW_REQUIRED">{VERDICT_LABELS.REVIEW_REQUIRED}</option>
          <option value="UNKNOWN">{VERDICT_LABELS.UNKNOWN}</option>
        </SelectInput>
      </div>
      <SellerReviewTable rows={rows} sellers={data.sellers} busyDealId={busyDealId} feedback={feedback} onConfirm={(dealId, sellerId) => void confirmSeller(dealId, sellerId)} />
      {data.queueTruncated && <p className="card-note">Navbatning birinchi 500 yozuvi ko‘rsatilgan.</p>}
    </section>

    {data.confirmations.length > 0 && <section className="panel">
      <SellerReviewHeader title="Tasdiqlar tarixi" subtitle="Kim, qachon va Bitrix yozuvi holati" />
      <div className="table-wrap"><table>
        <thead><tr><th>Deal</th><th>Sotuvchi</th><th>Tasdiqlagan</th><th>Sana</th><th>Bitrix</th></tr></thead>
        <tbody>{data.confirmations.map((entry) => <tr key={entry.dealId}>
          <td>#{entry.dealId}</td><td>{entry.sellerName ?? entry.sellerId}</td><td>{entry.confirmedBy}</td>
          <td>{day(entry.confirmedAt)}</td>
          <td>{WRITE_STATUS_LABELS[entry.bitrixWriteStatus ?? ""] ?? entry.bitrixWriteStatus ?? "—"}{entry.bitrixErrorCode ? ` (${entry.bitrixErrorCode})` : ""}</td>
        </tr>)}</tbody>
      </table></div>
    </section>}
  </>;
}

/** Local copy of the dashboard's section header, so this screen stays standalone. */
function SellerReviewHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return <div className="section-header">
    <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
    {action}
  </div>;
}
