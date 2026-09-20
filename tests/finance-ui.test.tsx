import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountDrawer, CategoryDrawer, ProjectDrawer, SubscriptionDrawer, TransactionDrawer } from "../app/finance/finance-drawers";
import {
  ArchiveStatusBadge, CurrencyKpiRow, EmptyState, ErrorState, FixtureNotice, LoadingState,
  MoneyByCurrencyLines,
} from "../app/finance/finance-view-exports";
import { FINANCE_TABS, FINANCE_TAB_LABELS } from "../app/finance/finance-view-exports";
import { isFinanceView, isManagementView, isSalesView } from "../app/dashboard-client";
import { cloneFixtures } from "../lib/finance-fixtures";

const view = readFileSync(new URL("../app/finance/finance-view.tsx", import.meta.url), "utf8");
const drawers = readFileSync(new URL("../app/finance/finance-drawers.tsx", import.meta.url), "utf8");
const adapter = readFileSync(new URL("../lib/finance-adapter.ts", import.meta.url), "utf8");
const client = readFileSync(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const dataset = cloneFixtures();

test("Finance is an isolated management view with all six screens", () => {
  assert.equal(isFinanceView("finance"), true);
  assert.equal(isSalesView("finance"), false);
  assert.equal(isManagementView("finance"), true);
  assert.deepEqual([...FINANCE_TABS], ["overview", "transactions", "accounts", "categories", "projects", "subscriptions"]);
  assert.deepEqual(Object.values(FINANCE_TAB_LABELS), ["Umumiy", "Yozuvlar", "Hisoblar", "Kategoriyalar", "Projectlar", "Obunalar"]);
  assert.match(client, /\{view === "finance" && <FinanceView \/>\}/);
});

test("money components render separate minor-unit totals per currency", () => {
  const html = renderToStaticMarkup(<MoneyByCurrencyLines value={{ UZS: 12_500_000, USD: 420_000 }} />);
  assert.match(html, /125[,.\s]000/);
  assert.match(html, /4[,.\s]200/);
  assert.equal((html.match(/fin-money/g) ?? []).length >= 2, true);
  assert.doesNotMatch(html, /129[,.\s]200/);
  const card = renderToStaticMarkup(<CurrencyKpiRow label="Kirim" value={{ UZS: 100, USD: 200 }} icon={null} />);
  assert.equal((card.match(/<strong/g) ?? []).length, 2);
});

test("Overview consumes the server summary instead of recalculating canonical totals", () => {
  assert.match(view, /const summary = dataset\.summary/);
  assert.match(view, /operatingMaps\(summary\)/);
  assert.match(view, /accountBalanceGroups\(summary\)/);
  assert.doesNotMatch(view, /summarize\(|overviewModel\(/);
});

test("transaction drawer maps human input through minor-unit parsing", () => {
  const html = renderToStaticMarkup(<TransactionDrawer open dataset={dataset} onClose={() => {}} onSave={async () => {}} />);
  assert.match(html, /Kirim/);
  assert.match(html, /Chiqim/);
  assert.match(html, /O‘tkazma/);
  assert.match(drawers, /parseMoneyInput\(amount, from\.currencyCode/);
  assert.match(drawers, /destinationAmountMinor/);
  assert.doesNotMatch(drawers, /amount:\s*Number\(amount\)/);
});

test("cross-currency UI asks for both values and never derives an FX rate", () => {
  const html = renderToStaticMarkup(<TransactionDrawer open dataset={dataset} initialType="TRANSFER" onClose={() => {}} onSave={async () => {}} />);
  assert.match(html, /Qaysi hisobdan/);
  assert.match(html, /Qaysi hisobga/);
  assert.match(drawers, /Tushadigan summa/);
  assert.match(drawers, /Kurs avtomatik hisoblanmaydi/);
  assert.doesNotMatch(drawers, /destinationAmountMinor\s*=\s*[^;]*[*/]/);
});

test("income and expense category is required while Finance Project remains optional", () => {
  const html = renderToStaticMarkup(<TransactionDrawer open dataset={dataset} initialType="EXPENSE" onClose={() => {}} onSave={async () => {}} />);
  assert.match(html, /Kategoriya/);
  assert.match(html, /Project belgilanmagan/);
  assert.match(html, /Ixtiyoriy — Project tanlanmasa ham yozuv saqlanadi/);
});

test("Account uses openingBalanceMinor and never exposes an editable current balance", () => {
  const html = renderToStaticMarkup(<AccountDrawer open account={dataset.accounts[0]} onClose={() => {}} onSave={async () => {}} />);
  assert.match(html, /Boshlang‘ich balans/);
  assert.match(html, /Joriy balans faqat server summary’dan o‘qiladi/);
  assert.match(drawers, /openingBalanceMinor/);
  assert.doesNotMatch(drawers, /currentBalanceMinor:\s*/);
});

test("category hierarchy and archive UI use canonical archived boolean", () => {
  const html = renderToStaticMarkup(<CategoryDrawer open kind="EXPENSE" category={null} categories={dataset.categories} onClose={() => {}} onSave={async () => {}} />);
  assert.match(html, /Marketing/);
  assert.doesNotMatch(html, /Mijoz to‘lovi/);
  assert.match(view, /archived: !category\.archived/);
  assert.doesNotMatch(view, /status: category\.status/);
  assert.match(renderToStaticMarkup(<ArchiveStatusBadge archived />), /Arxivlangan/);
});

test("Finance Projects stay a separate cost-centre model", () => {
  const html = renderToStaticMarkup(<ProjectDrawer open project={null} onClose={() => {}} onSave={async () => {}} />);
  assert.match(html, /Nomi/);
  assert.match(html, /Izoh/);
  assert.doesNotMatch(html, /Summa|Valyuta/);
  assert.doesNotMatch(adapter, /\/api\/projects\b/);
});

test("subscription form matches backend direction, category, dates and reminder-only contract", () => {
  const html = renderToStaticMarkup(<SubscriptionDrawer open subscription={null} dataset={dataset} onClose={() => {}} onSave={async () => {}} />);
  assert.match(html, /Yo‘nalish/);
  assert.match(html, /Boshlanish sanasi/);
  assert.match(html, /Tugash sanasi/);
  assert.match(html, /Keyingi to‘lov sanasi/);
  assert.match(html, /Obuna yozuvni o‘zi yaratmaydi/);
  assert.match(drawers, /amountMinor/);
});

test("production error, loading, and empty states are visible", () => {
  assert.match(renderToStaticMarkup(<LoadingState />), /role="status"/);
  assert.match(renderToStaticMarkup(<ErrorState message="D1 unavailable" onRetry={() => {}} />), /D1 unavailable/);
  assert.match(renderToStaticMarkup(<EmptyState title="Hisob yo‘q" />), /Hisob yo‘q/);
  assert.match(view, /error \? <ErrorState/);
});

test("fixture warning exists only for deliberately selected fixture mode", () => {
  assert.match(renderToStaticMarkup(<FixtureNotice />), /Namuna ma’lumotlari/);
  assert.match(view, /source === "fixtures"/);
  assert.match(adapter, /mode = "api"/);
  assert.doesNotMatch(adapter, /mode === "auto"|fall back|fallback to fixtures/i);
});

test("Finance state cannot alter Sales state or trigger CRM operations", () => {
  assert.match(view, /const \[range, setRange\] = useState<FinanceRange>/);
  for (const forbidden of ["setFilters", "buildDashboardMetrics", "buildAnalyticsRecords", "cohortFiltered", "wonFiltered", "record-filters"]) {
    assert.doesNotMatch(view, new RegExp(forbidden));
  }
  for (const source of [view, drawers, adapter]) {
    assert.doesNotMatch(source, /\/api\/(?:dashboard|sync|bootstrap|reconcile|settings|current-stages)/);
    assert.doesNotMatch(source, /startSync|runSync|backfill/i);
  }
  assert.match(css, /\.fin-row-archived \{ opacity: \.55; \}/);
});
