"use client";

import { Archive, Inbox, Loader2, TriangleAlert } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";

import { formatMoney, moneyLines } from "@/lib/finance-money";
import { FINANCE_CURRENCIES } from "@/lib/finance/money";
import type { Currency, FinanceCurrency, MoneyByCurrency } from "@/lib/finance-types";

/**
 * Shared Finance display primitives.
 *
 * `MoneyByCurrencyLines` is the only way an aggregate is rendered. It emits one
 * line per currency and has no code path that produces a combined figure, so a
 * mixed-currency total cannot reach the screen even by mistake.
 */

const DEFAULT_CURRENCIES: FinanceCurrency[] = FINANCE_CURRENCIES.map((currency) => ({ ...currency, archived: false }));
const FinanceCurrencyContext = createContext<readonly FinanceCurrency[]>(DEFAULT_CURRENCIES);

export function FinanceCurrencyProvider({ currencies, children }: { currencies: readonly FinanceCurrency[]; children: ReactNode }) {
  return <FinanceCurrencyContext.Provider value={currencies}>{children}</FinanceCurrencyContext.Provider>;
}

export function useFinanceCurrency(currencyCode: string | null | undefined) {
  const currencies = useContext(FinanceCurrencyContext);
  return currencies.find((currency) => currency.code === currencyCode) ?? null;
}

export function Money({ amountMinor, currency, tone }: { amountMinor: number; currency: Currency; tone?: "income" | "expense" | "neutral" }) {
  const className = tone === "income" ? "fin-money income" : tone === "expense" ? "fin-money expense" : "fin-money";
  const definition = useFinanceCurrency(currency);
  return <span className={className}>{definition ? formatMoney(amountMinor, definition) : "—"}</span>;
}

export function MoneyByCurrencyLines({ value, tone, emptyLabel = "—", includeZero = false }: {
  value: MoneyByCurrency;
  tone?: "income" | "expense" | "neutral";
  emptyLabel?: string;
  includeZero?: boolean;
}) {
  const lines = moneyLines(value, { includeZero });
  if (!lines.length) return <span className="fin-money muted">{emptyLabel}</span>;
  return (
    <span className="fin-money-lines">
      {lines.map((line) => (
        <Money key={line.currency} amountMinor={line.amountMinor} currency={line.currency} tone={tone} />
      ))}
    </span>
  );
}

/** One KPI card per currency. Never one card summing several. */
export function CurrencyKpiRow({ label, value, tone, icon, note }: {
  label: string;
  value: MoneyByCurrency;
  tone?: "income" | "expense" | "neutral";
  icon: ReactNode;
  note?: string;
}) {
  const lines = moneyLines(value);
  return (
    <div className={`kpi-card fin-kpi ${tone ?? ""}`}>
      <div className="kpi-top"><span>{label}</span><span className="kpi-icon">{icon}</span></div>
      {lines.length ? (
        <div className="fin-kpi-values">
          {lines.map((line) => (
            <strong key={line.currency}><Money amountMinor={line.amountMinor} currency={line.currency} tone={tone} /></strong>
          ))}
        </div>
      ) : (
        <div className="fin-kpi-values"><strong className="muted">0</strong></div>
      )}
      {note && <small className="card-note">{note}</small>}
    </div>
  );
}

export function SectionHeading({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="fin-section-head">
      <div><h3>{title}</h3>{subtitle && <p>{subtitle}</p>}</div>
      {action}
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="fin-empty">
      <Inbox size={22} aria-hidden="true" />
      <strong>{title}</strong>
      {hint && <p>{hint}</p>}
      {action}
    </div>
  );
}

export function LoadingState({ label = "Yuklanmoqda…" }: { label?: string }) {
  return (
    <div className="fin-loading" role="status" aria-live="polite">
      <Loader2 size={18} className="spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="fin-error" role="alert">
      <TriangleAlert size={18} aria-hidden="true" />
      <div><strong>Ma’lumot yuklanmadi</strong><p>{message}</p></div>
      {onRetry && <button type="button" className="button secondary small" onClick={onRetry}>Qayta urinish</button>}
    </div>
  );
}

/** Archived rows stay visible but must never read as active. */
export function ArchivedBadge({ label = "Arxivlangan" }: { label?: string }) {
  return <span className="fin-badge archived"><Archive size={11} aria-hidden="true" />{label}</span>;
}

export function ArchiveStatusBadge({ archived }: { archived: boolean }) {
  return archived ? <ArchivedBadge /> : <span className="fin-badge active">Aktiv</span>;
}

/**
 * Sample-data warning.
 *
 * Shown whenever the adapter served fixtures. An owner must never mistake
 * development data for their own books.
 */
export function FixtureNotice() {
  return (
    <div className="notice warning fin-notice">
      <TriangleAlert size={16} aria-hidden="true" />
      <span><strong>Namuna ma’lumotlari.</strong> Finance backend hali ulanmagan — bu raqamlar haqiqiy emas.</span>
    </div>
  );
}
