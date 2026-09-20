import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CurrencyKpiRow, EmptyState, ErrorState, FixtureNotice, LoadingState, MoneyByCurrencyLines, StatusBadge } from "../app/finance/finance-view-exports";
import { FINANCE_TABS, FINANCE_TAB_LABELS } from "../app/finance/finance-view-exports";
import { AccountDrawer, CategoryDrawer, ProjectDrawer, SubscriptionDrawer, TransactionDrawer } from "../app/finance/finance-drawers";
import { cloneFixtures } from "../lib/finance-fixtures";
import { isFinanceView, isManagementView, isSalesView } from "../app/dashboard-client";

/**
 * Finance UI contract.
 *
 * Stateful screens are asserted against their source, the same convention the
 * existing UI tests use; anything renderable is rendered. The invariant checked
 * hardest: no mixed-currency total reaches the DOM.
 */

const view = readFileSync(new URL("../app/finance/finance-view.tsx", import.meta.url), "utf8");
const drawers = readFileSync(new URL("../app/finance/finance-drawers.tsx", import.meta.url), "utf8");
const client = readFileSync(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const dataset = cloneFixtures();

// --------------------------------------------------------------- navigation ---

test("Finance is its own nav entry and is not a Sales view", () => {
  assert.match(client, /\{ id: "finance", label: "Moliya", icon: Wallet \}/);
  assert.match(client, /\{view === "finance" && <FinanceView \/>\}/);
  assert.equal(isFinanceView("finance"), true);
  assert.equal(isSalesView("finance"), false, "Finance must not carry the Sales cohort filter bar");
  assert.equal(isManagementView("finance"), true);
  // The existing Sales views are untouched.
  for (const salesView of ["dashboard", "managers", "leadFlow", "quality", "stages", "deals"]) {
    assert.equal(isSalesView(salesView), true, salesView);
  }
});

test("Finance has all six sub-sections", () => {
  assert.deepEqual([...FINANCE_TABS], ["overview", "transactions", "accounts", "categories", "projects", "subscriptions"]);
  assert.deepEqual(Object.values(FINANCE_TAB_LABELS), ["Umumiy", "Yozuvlar", "Hisoblar", "Kategoriyalar", "Projectlar", "Obunalar"]);
  assert.match(view, /aria-label="Finance bo‘limlari"/);
  assert.match(view, /aria-current=\{tab === item \? "page" : undefined\}/);
});

// ------------------------------------------------------------------ currency ---

test("an aggregate renders one line per currency and never a combined total", () => {
  const html = renderToStaticMarkup(<MoneyByCurrencyLines value={{ UZS: 125_000_000, USD: 4_200 }} />);
  assert.match(html, /125 000 000 UZS/);
  assert.match(html, /4 200,00 USD/);
  // The blended figure must not appear in any form.
  assert.doesNotMatch(html, /129 200 000/);
  assert.equal((html.match(/fin-money/g) ?? []).length >= 2, true, "two separate spans");
});

test("a KPI card shows a figure per currency, not one summed figure", () => {
  const html = renderToStaticMarkup(
    <CurrencyKpiRow label="Kirim" value={{ UZS: 43_250_000, USD: 1_800 }} icon={null} />,
  );
  assert.match(html, /43 250 000 UZS/);
  assert.match(html, /1 800,00 USD/);
  assert.equal((html.match(/<strong>/g) ?? []).length, 2, "one strong per currency");
  assert.doesNotMatch(html, /43 251 800/);
});

test("a zero currency is not rendered as a value, and an empty aggregate reads as a dash", () => {
  assert.match(renderToStaticMarkup(<MoneyByCurrencyLines value={{}} />), /—/);
  const html = renderToStaticMarkup(<MoneyByCurrencyLines value={{ UZS: 10, USD: 0 }} />);
  assert.match(html, /10 UZS/);
  assert.doesNotMatch(html, /0 USD/);
});

test("no component sums across currencies, and the note tells the owner so", () => {
  // Every aggregate in the view goes through the per-currency component.
  assert.match(view, /Valyutalar hech qachon qo‘shilmaydi/);
  assert.doesNotMatch(view, /grandTotal|totalAll|combinedTotal/i);
  // Money is only ever rendered through the two currency-safe components.
  assert.doesNotMatch(view, /toLocaleString\(/, "formatting goes through formatMoney only");
});

// ------------------------------------------------------- transaction drawer ---

test("the transaction drawer offers exactly Kirim, Chiqim and O‘tkazma", () => {
  const html = renderToStaticMarkup(
    <TransactionDrawer open dataset={dataset} onClose={() => {}} onSave={async () => {}} />,
  );
  assert.match(html, /Kirim/);
  assert.match(html, /Chiqim/);
  assert.match(html, /O‘tkazma/);
  assert.match(html, /aria-label="Yozuv turi"/);
});

test("an income or expense form offers category and an optional Project", () => {
  const html = renderToStaticMarkup(
    <TransactionDrawer open dataset={dataset} initialType="EXPENSE" onClose={() => {}} onSave={async () => {}} />,
  );
  assert.match(html, /Kategoriyasiz/, "a category is optional");
  assert.match(html, /Project belgilanmagan/, "a Project is optional");
  assert.match(html, /Ixtiyoriy — Project tanlanmasa ham yozuv saqlanadi/);
});

test("the transfer form asks for both accounts, and both amounts only when currencies differ", () => {
  const html = renderToStaticMarkup(
    <TransactionDrawer open dataset={dataset} initialType="TRANSFER" onClose={() => {}} onSave={async () => {}} />,
  );
  assert.match(html, /Qaysi hisobdan/);
  assert.match(html, /Qaysi hisobga/);
  // The cross-currency branch is conditional on the two selected accounts.
  assert.match(drawers, /const crossCurrency = type === "TRANSFER" && transferShape\(from, to\)\.crossCurrency;/);
  assert.match(drawers, /\{crossCurrency && \(/);
  assert.match(drawers, /Tushadigan summa/);
  assert.match(drawers, /Kurs avtomatik hisoblanmaydi/, "the UI states that no rate is applied");
  // No arithmetic derives the second amount.
  assert.doesNotMatch(drawers, /toAmount\s*=\s*[^;]*amount\s*[*/]/, "the second amount is never computed from the first");
});

test("a transfer never offers a category or a Project", () => {
  assert.match(drawers, /\{type !== "TRANSFER" && \(/, "the fields are hidden in the form");
  // And the rule is enforced in the body builder, not only in the markup.
  const metrics = readFileSync(new URL("../lib/finance-metrics.ts", import.meta.url), "utf8");
  assert.match(metrics, /categoryId: draft\.type === "TRANSFER" \? null : draft\.categoryId/);
  assert.match(metrics, /projectId: draft\.type === "TRANSFER" \? null : draft\.projectId/);
});

// ------------------------------------------------------------- other drawers ---

test("the account drawer offers the four types and never an editable current balance", () => {
  const html = renderToStaticMarkup(<AccountDrawer open account={null} onClose={() => {}} onSave={async () => {}} />);
  for (const label of ["Naqd", "Bank", "Karta", "Boshqa"]) assert.match(html, new RegExp(label));
  assert.match(html, /Joriy balans yozuvlardan hisoblanadi — qo‘lda tahrirlanmaydi/);
  const editing = renderToStaticMarkup(
    <AccountDrawer open account={dataset.accounts[0]} onClose={() => {}} onSave={async () => {}} />,
  );
  assert.match(editing, /readonly|disabled/, "the current balance field is not editable");
});

test("the category drawer offers only parents of the same kind", () => {
  const expense = renderToStaticMarkup(
    <CategoryDrawer open kind="EXPENSE" category={null} categories={dataset.categories} onClose={() => {}} onSave={async () => {}} />,
  );
  assert.match(expense, /Marketing/, "an expense parent is offered");
  assert.doesNotMatch(expense, /Mijoz to‘lovi/, "an income parent is never offered under Chiqim");
  const income = renderToStaticMarkup(
    <CategoryDrawer open kind="INCOME" category={null} categories={dataset.categories} onClose={() => {}} onSave={async () => {}} />,
  );
  assert.match(income, /Mijoz to‘lovi/);
  assert.doesNotMatch(income, /Marketing/);
  assert.match(expense, /Faqat chiqim kategoriyalari ko‘rsatiladi/);
});

test("the subscription drawer promises a reminder, never an automatic payment", () => {
  const html = renderToStaticMarkup(
    <SubscriptionDrawer open subscription={null} dataset={dataset} onClose={() => {}} onSave={async () => {}} />,
  );
  assert.match(html, /Keyingi to‘lov sanasi/);
  assert.match(html, /Obuna yozuvni o‘zi yaratmaydi/);
  for (const label of ["Har oy", "Har chorak", "Har yil", "Har N oy"]) assert.match(html, new RegExp(label));
  // The forbidden claim must appear nowhere in the Finance UI.
  for (const source of [html, view, drawers]) {
    assert.doesNotMatch(source, /Avtomatik yechiladi|avtomatik to‘lanadi|avtomatik yechib/i);
  }
});

test("the project drawer is a simple cost centre, with no money fields", () => {
  const html = renderToStaticMarkup(<ProjectDrawer open project={null} onClose={() => {}} onSave={async () => {}} />);
  assert.match(html, /Nomi/);
  assert.match(html, /Izoh/);
  assert.doesNotMatch(html, /Summa|Valyuta/, "a Project carries no amount of its own");
});

// -------------------------------------------------------------------- states ---

test("empty, loading and error states are real components, not blank space", () => {
  const empty = renderToStaticMarkup(<EmptyState title="Hisob yo‘q" hint="Birinchi hisobni qo‘shing." />);
  assert.match(empty, /Hisob yo‘q/);
  assert.match(empty, /Birinchi hisobni qo‘shing/);

  const loading = renderToStaticMarkup(<LoadingState />);
  assert.match(loading, /role="status"/);
  assert.match(loading, /aria-live="polite"/);
  assert.match(loading, /Yuklanmoqda/);

  const error = renderToStaticMarkup(<ErrorState message="Finance API xatosi (500)" onRetry={() => {}} />);
  assert.match(error, /role="alert"/);
  assert.match(error, /Finance API xatosi \(500\)/);
  assert.match(error, /Qayta urinish/);
});

test("the view renders loading, error and empty states rather than assuming data", () => {
  assert.match(view, /loading \? <LoadingState \/>/);
  assert.match(view, /error \? <ErrorState message=\{error\}/);
  assert.equal((view.match(/<EmptyState/g) ?? []).length >= 6, true, "every screen has an empty state");
});

test("sample data is labelled so it cannot be mistaken for the real books", () => {
  const html = renderToStaticMarkup(<FixtureNotice />);
  assert.match(html, /Namuna ma’lumotlari/);
  assert.match(html, /bu raqamlar haqiqiy emas/);
  assert.match(view, /\{source === "fixtures" && <FixtureNotice \/>\}/);
});

test("archived rows are visually distinct and reversible", () => {
  assert.match(renderToStaticMarkup(<StatusBadge status="ARCHIVED" />), /Arxivlangan/);
  assert.match(renderToStaticMarkup(<StatusBadge status="ACTIVE" />), /Aktiv/);
  assert.match(css, /\.fin-row-archived \{ opacity: \.55; \}/);
  assert.match(css, /\.fin-badge\.archived/);
  // Every archivable entity offers archive and restore.
  // Accounts, category parents, category children, projects and subscriptions.
  assert.equal((view.match(/\? "Tiklash" : "Arxivlash"/g) ?? []).length, 5);
});

// --------------------------------------------------------- Sales isolation ---

test("Finance never touches Sales filter state or Sales analytics", () => {
  // Finance holds its own range in its own component state.
  assert.match(view, /const \[range, setRange\] = useState<FinanceRange>/);
  // It must not reach for the Sales filter state or its metrics.
  for (const forbidden of ["setFilters", "emptyFilters", "buildDashboardMetrics", "buildAnalyticsRecords", "cohortFiltered", "wonFiltered", "record-filters"]) {
    assert.doesNotMatch(view, new RegExp(forbidden), `Finance must not use ${forbidden}`);
  }
  // The dashboard renders Finance without handing it any Sales state.
  assert.match(client, /\{view === "finance" && <FinanceView \/>\}/, "no Sales props are passed in");
  // Finance only imports Finance libraries plus shared UI primitives.
  const imports = [...view.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
  const libImports = imports.filter((path) => path.startsWith("@/lib/"));
  assert.deepEqual([...new Set(libImports)].sort(), ["@/lib/finance-adapter", "@/lib/finance-metrics", "@/lib/finance-types"]);
});

test("Finance owns no Sales endpoint and no CRM sync trigger", () => {
  for (const source of [view, drawers]) {
    assert.doesNotMatch(source, /\/api\/(?:dashboard|sync|bootstrap|reconcile|settings|current-stages)/);
    assert.doesNotMatch(source, /startSync|runSync|backfill/i);
  }
});
