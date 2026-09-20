"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDownLeft, ArrowUpRight, ArrowLeftRight, CalendarClock, FolderKanban,
  Layers, Plus, Search, Wallet,
} from "lucide-react";

import { MultiSelect } from "../ui/multi-select";
import { DateInput } from "../ui/form";
import {
  ArchivedBadge, CurrencyKpiRow, EmptyState, ErrorState, FixtureNotice, LoadingState,
  Money, MoneyByCurrencyLines, SectionHeading, StatusBadge,
} from "./finance-primitives";
import { AccountDrawer, CategoryDrawer, ProjectDrawer, SubscriptionDrawer, TransactionDrawer } from "./finance-drawers";
import { createFinanceAdapter, emptyDataset, type FinanceAdapter, type FinanceSource } from "@/lib/finance-adapter";
import {
  accountBalances, addDays, cadenceMonths, categoryTree, filterTransactions, overviewModel, projectSpending,
  subscriptionBuckets, type FinanceFilters,
} from "@/lib/finance-metrics";
import {
  ACCOUNT_TYPE_LABELS, CADENCE_LABELS, CURRENCIES, TRANSACTION_TYPES, TRANSACTION_TYPE_LABELS,
  type CategoryKind, type Currency, type FinanceAccount, type FinanceCategory, type FinanceDataset,
  type FinanceProject, type FinanceSubscription, type TransactionType,
} from "@/lib/finance-types";

/**
 * Finance MVP.
 *
 * Six screens over one dataset loaded through `lib/finance-adapter`. Every number
 * comes from `lib/finance-metrics`, so no screen derives its own arithmetic and
 * two screens cannot disagree about the same figure.
 *
 * Finance holds its own date filter and its own state. It deliberately shares
 * nothing with the Sales cohort filter: Sales analytics must not shift because
 * someone opened Finance.
 */

export const FINANCE_TABS = ["overview", "transactions", "accounts", "categories", "projects", "subscriptions"] as const;
export type FinanceTab = (typeof FINANCE_TABS)[number];
export const FINANCE_TAB_LABELS: Record<FinanceTab, string> = {
  overview: "Umumiy", transactions: "Yozuvlar", accounts: "Hisoblar",
  categories: "Kategoriyalar", projects: "Projectlar", subscriptions: "Obunalar",
};

const todayKey = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${todayKey().slice(0, 7)}-01`;

export type FinanceRange = { from: string; to: string };

/**
 * Loads the dataset and exposes a reload for retries and post-mutation refresh.
 *
 * The first load starts from the effect but deliberately sets no state
 * synchronously: `apply` only runs after the adapter's await, so React is not
 * asked to re-render inside the effect body. `reload` may set `loading` up front
 * because it is always called from an event handler, never from an effect.
 */
export function useFinanceData(adapter: FinanceAdapter) {
  const [dataset, setDataset] = useState<FinanceDataset>(emptyDataset);
  const [source, setSource] = useState<FinanceSource>("api");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((result: Awaited<ReturnType<FinanceAdapter["load"]>> | { error: string }) => {
    if ("dataset" in result) {
      setDataset(result.dataset); setSource(result.source); setError(result.error);
    } else {
      setError(result.error);
    }
    setLoading(false);
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try { apply(await adapter.load()); }
    catch (caught) { apply({ error: caught instanceof Error ? caught.message : "Finance ma’lumotlari yuklanmadi" }); }
  }, [adapter, apply]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await adapter.load();
        if (!cancelled) apply(result);
      } catch (caught) {
        if (!cancelled) apply({ error: caught instanceof Error ? caught.message : "Finance ma’lumotlari yuklanmadi" });
      }
    })();
    return () => { cancelled = true; };
  }, [adapter, apply]);

  return { dataset, source, loading, error, reload };
}

export function FinanceView({ adapter: injected }: { adapter?: FinanceAdapter } = {}) {
  const adapter = useMemo(() => injected ?? createFinanceAdapter(), [injected]);
  const { dataset, source, loading, error, reload } = useFinanceData(adapter);
  const [tab, setTab] = useState<FinanceTab>("overview");
  const [range, setRange] = useState<FinanceRange>({ from: monthStart(), to: todayKey() });
  const [addOpen, setAddOpen] = useState(false);
  const [addType, setAddType] = useState<TransactionType>("EXPENSE");

  const openAdd = (type: TransactionType) => { setAddType(type); setAddOpen(true); };

  return (
    <section className="fin-shell" aria-label="Finance">
      <div className="page-title">
        <div>
          <p className="eyebrow">FINANCE</p>
          <h1>Moliya</h1>
          <p>Qayerda qancha pul bor, davr ichida qancha kirim va chiqim bo‘lgan, pul qayerga ketgan.</p>
        </div>
        <div className="fin-quick-actions">
          <button type="button" className="button" onClick={() => openAdd("INCOME")}><Plus size={15} />Kirim</button>
          <button type="button" className="button secondary" onClick={() => openAdd("EXPENSE")}><Plus size={15} />Chiqim</button>
          <button type="button" className="button secondary" onClick={() => openAdd("TRANSFER")}><ArrowLeftRight size={15} />O‘tkazma</button>
        </div>
      </div>

      {source === "fixtures" && <FixtureNotice />}

      <nav className="fin-tabs" aria-label="Finance bo‘limlari">
        {FINANCE_TABS.map((item) => (
          <button key={item} type="button" className={tab === item ? "active" : ""}
            aria-current={tab === item ? "page" : undefined} onClick={() => setTab(item)}>
            {FINANCE_TAB_LABELS[item]}
          </button>
        ))}
      </nav>

      {tab !== "accounts" && tab !== "categories" && (
        <div className="fin-range">
          <label>Boshlanish<DateInput value={range.from} onChange={(event) => setRange((current) => ({ ...current, from: event.target.value }))} /></label>
          <label>Tugash<DateInput value={range.to} onChange={(event) => setRange((current) => ({ ...current, to: event.target.value }))} /></label>
        </div>
      )}

      {loading ? <LoadingState />
        : error ? <ErrorState message={error} onRetry={() => void reload()} />
        : (
          <>
            {tab === "overview" && <OverviewTab dataset={dataset} range={range} />}
            {tab === "transactions" && <TransactionsTab dataset={dataset} range={range} onAdd={openAdd} />}
            {tab === "accounts" && <AccountsTab dataset={dataset} adapter={adapter} onChanged={reload} />}
            {tab === "categories" && <CategoriesTab dataset={dataset} adapter={adapter} onChanged={reload} />}
            {tab === "projects" && <ProjectsTab dataset={dataset} range={range} adapter={adapter} onChanged={reload} />}
            {tab === "subscriptions" && <SubscriptionsTab dataset={dataset} adapter={adapter} onChanged={reload} />}
          </>
        )}

      <TransactionDrawer open={addOpen} dataset={dataset} initialType={addType}
        onClose={() => setAddOpen(false)}
        onSave={async (body) => { await adapter.createTransaction(body); await reload(); }} />
    </section>
  );
}

// ------------------------------------------------------------------ overview ---

function OverviewTab({ dataset, range }: { dataset: FinanceDataset; range: FinanceRange }) {
  const model = useMemo(() => overviewModel(dataset, { ...range }, todayKey()), [dataset, range]);
  const { summary, balances, subscriptions } = model;

  return (
    <div className="fin-stack">
      <div className="kpi-grid fin-kpi-grid">
        <CurrencyKpiRow label="Kirim" value={summary.income} tone="income" icon={<ArrowDownLeft size={15} />} note="Tanlangan davr" />
        <CurrencyKpiRow label="Chiqim" value={summary.expense} tone="expense" icon={<ArrowUpRight size={15} />} note="Tanlangan davr" />
        <CurrencyKpiRow label="Net cash flow" value={summary.net} icon={<Wallet size={15} />} note="Kirim − Chiqim" />
        <CurrencyKpiRow label="Hisoblardagi pul" value={balances.totals} icon={<Wallet size={15} />} note={`${balances.activeCount} aktiv hisob`} />
      </div>
      <p className="fin-currency-note">Valyutalar hech qachon qo‘shilmaydi — har biri alohida ko‘rsatiladi.</p>

      <section className="panel">
        <SectionHeading title="Hisoblardagi qoldiq" subtitle="Har valyuta alohida jamlanadi" />
        {balances.byCurrency.length ? balances.byCurrency.map((group) => (
          <div key={group.currency} className="fin-balance-group">
            <div className="fin-balance-head"><strong>{group.currency}</strong><Money amount={group.total} currency={group.currency} /></div>
            <table className="fin-table">
              <thead><tr><th>Hisob</th><th>Turi</th><th>Valyuta</th><th className="right">Joriy balans</th></tr></thead>
              <tbody>
                {group.accounts.map((account) => (
                  <tr key={account.id}>
                    <td>{account.name}</td>
                    <td>{ACCOUNT_TYPE_LABELS[account.type]}</td>
                    <td>{account.currency}</td>
                    <td className="right"><Money amount={account.currentBalance} currency={account.currency} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )) : <EmptyState title="Hisob yo‘q" hint="Hisoblar bo‘limida birinchi hisobni qo‘shing." />}
        {balances.archived.length > 0 && (
          <p className="fin-archived-note"><ArchivedBadge /> {balances.archived.length} arxivlangan hisob jamlanmaga kirmaydi.</p>
        )}
      </section>

      <div className="fin-two-col">
        <BreakdownPanel title="Chiqim kategoriyalari" rows={model.expenseByCategory} tone="expense"
          empty="Tanlangan davrda chiqim yo‘q" />
        <BreakdownPanel title="Kirim kategoriyalari" rows={model.incomeByCategory} tone="income"
          empty="Tanlangan davrda kirim yo‘q" />
      </div>

      <section className="panel">
        <SectionHeading title="Project xarajatlari" subtitle="Project tanlanmagan yozuvlar alohida qatorda" />
        <ProjectTable rows={model.projects} />
      </section>

      <section className="panel">
        <SectionHeading title="Keyingi to‘lovlar" subtitle="Obuna faqat eslatma — to‘lov avtomatik yaratilmaydi" />
        {subscriptions.overdue.length + subscriptions.upcoming.length ? (
          <>
            <p className="fin-subs-total">Kutilayotgan summa: <MoneyByCurrencyLines value={subscriptions.upcomingByCurrency} tone="expense" /></p>
            <SubscriptionTable rows={[...subscriptions.overdue, ...subscriptions.upcoming]} dataset={dataset} today={todayKey()} />
          </>
        ) : <EmptyState title="Yaqin 30 kunda to‘lov yo‘q" />}
      </section>
    </div>
  );
}

function BreakdownPanel({ title, rows, tone, empty }: {
  title: string;
  rows: { categoryId: string | null; label: string; byCurrency: Record<string, number | undefined>; transactions: number }[];
  tone: "income" | "expense";
  empty: string;
}) {
  return (
    <section className="panel">
      <SectionHeading title={title} />
      {rows.length ? (
        <table className="fin-table">
          <thead><tr><th>Kategoriya</th><th className="right">Yozuv</th><th className="right">Summa</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.categoryId ?? "none"}>
                <td>{row.label}</td>
                <td className="right">{row.transactions}</td>
                <td className="right"><MoneyByCurrencyLines value={row.byCurrency} tone={tone} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <EmptyState title={empty} />}
    </section>
  );
}

function ProjectTable({ rows }: { rows: ReturnType<typeof projectSpending> }) {
  if (!rows.length) return <EmptyState title="Tanlangan davrda Project yozuvlari yo‘q" />;
  return (
    <table className="fin-table">
      <thead><tr><th>Project</th><th className="right">Kirim</th><th className="right">Chiqim</th><th className="right">Net</th></tr></thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.projectId ?? "none"} className={row.status === "ARCHIVED" ? "fin-row-archived" : ""}>
            <td>{row.name}{row.status === "ARCHIVED" && <> <ArchivedBadge /></>}</td>
            <td className="right"><MoneyByCurrencyLines value={row.income} tone="income" /></td>
            <td className="right"><MoneyByCurrencyLines value={row.expense} tone="expense" /></td>
            <td className="right"><MoneyByCurrencyLines value={row.net} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// -------------------------------------------------------------- transactions ---

function TransactionsTab({ dataset, range, onAdd }: {
  dataset: FinanceDataset; range: FinanceRange; onAdd: (type: TransactionType) => void;
}) {
  const [types, setTypes] = useState<string[]>([]);
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [currencies, setCurrencies] = useState<string[]>([]);
  const [search, setSearch] = useState("");

  // Built inside the memo so a fresh object literal cannot invalidate it on
  // every render.
  const rows = useMemo(() => {
    const filters: FinanceFilters = {
      from: range.from, to: range.to,
      types: types as TransactionType[],
      accountIds, categoryIds, projectIds,
      currencies: currencies as Currency[],
      search,
    };
    return filterTransactions(dataset.transactions, filters)
      .sort((left, right) => right.date.localeCompare(left.date));
  }, [dataset.transactions, range.from, range.to, types, accountIds, categoryIds, projectIds, currencies, search]);
  const accountName = (id: string | null) => dataset.accounts.find((a) => a.id === id)?.name ?? "—";
  const categoryName = (id: string | null) => dataset.categories.find((c) => c.id === id)?.name ?? "—";
  const projectName = (id: string | null) => dataset.projects.find((p) => p.id === id)?.name ?? "—";
  const active = types.length + accountIds.length + categoryIds.length + projectIds.length + currencies.length;

  return (
    <div className="fin-stack">
      <div className="filters-shell fin-filters">
        <div className="filters-main">
          <div className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Izoh yoki summa…" /></div>
          <MultiSelect label="Turi" allLabel="Barcha turlar" selected={types} onChange={setTypes}
            options={TRANSACTION_TYPES.map((type) => ({ id: type, name: TRANSACTION_TYPE_LABELS[type] }))} />
          <MultiSelect label="Hisob" allLabel="Barcha hisoblar" selected={accountIds} onChange={setAccountIds}
            options={dataset.accounts.map((account) => ({ id: account.id, name: account.name }))} />
          <MultiSelect label="Kategoriya" allLabel="Barcha kategoriyalar" selected={categoryIds} onChange={setCategoryIds}
            options={dataset.categories.map((category) => ({ id: category.id, name: category.parentId ? `— ${category.name}` : category.name }))} />
          <MultiSelect label="Project" allLabel="Barcha projectlar" selected={projectIds} onChange={setProjectIds}
            options={dataset.projects.map((project) => ({ id: project.id, name: project.name }))} />
          <MultiSelect label="Valyuta" allLabel="Barcha valyutalar" selected={currencies} onChange={setCurrencies}
            options={CURRENCIES.map((currency) => ({ id: currency, name: currency }))} />
          {(active > 0 || search) && (
            <button type="button" className="clear-filter" onClick={() => { setTypes([]); setAccountIds([]); setCategoryIds([]); setProjectIds([]); setCurrencies([]); setSearch(""); }}>Tozalash</button>
          )}
          <button type="button" className="button small" onClick={() => onAdd("EXPENSE")}><Plus size={14} />Yozuv qo‘shish</button>
        </div>
      </div>

      <section className="panel">
        <SectionHeading title={`${rows.length} yozuv`} subtitle="Valyutalar aralashtirilmaydi — har yozuv o‘z valyutasida" />
        {rows.length ? (
          <table className="fin-table">
            <thead>
              <tr><th>Sana</th><th>Turi</th><th>Hisob</th><th>Kategoriya</th><th>Project</th><th>Izoh</th><th className="right">Summa</th></tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.date}</td>
                  <td><span className={`fin-type ${row.type.toLowerCase()}`}>{TRANSACTION_TYPE_LABELS[row.type]}</span></td>
                  <td>{row.type === "TRANSFER" ? `${accountName(row.accountId)} → ${accountName(row.toAccountId)}` : accountName(row.accountId)}</td>
                  <td>{row.type === "TRANSFER" ? "—" : categoryName(row.categoryId)}</td>
                  <td>{row.type === "TRANSFER" ? "—" : projectName(row.projectId)}</td>
                  <td>{row.description || "—"}</td>
                  <td className="right">
                    <Money amount={row.amount} currency={row.currency} tone={row.type === "INCOME" ? "income" : row.type === "EXPENSE" ? "expense" : "neutral"} />
                    {row.toAmount !== null && row.toCurrency !== null && (
                      <><br /><small className="fin-cross">→ <Money amount={row.toAmount} currency={row.toCurrency} /></small></>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <EmptyState title="Yozuv topilmadi" hint="Filtrlarni o‘zgartiring yoki yangi yozuv qo‘shing."
              action={<button type="button" className="button small" onClick={() => onAdd("EXPENSE")}>Yozuv qo‘shish</button>} />}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ accounts ---

function AccountsTab({ dataset, adapter, onChanged }: { dataset: FinanceDataset; adapter: FinanceAdapter; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState<FinanceAccount | null>(null);
  const [open, setOpen] = useState(false);
  const balances = accountBalances(dataset.accounts);

  const archive = async (account: FinanceAccount) => {
    await adapter.updateAccount(account.id, { status: account.status === "ARCHIVED" ? "ACTIVE" : "ARCHIVED" });
    await onChanged();
  };

  return (
    <div className="fin-stack">
      <SectionHeading title="Hisoblar" subtitle="Joriy balans yozuvlardan hisoblanadi — qo‘lda tahrirlanmaydi"
        action={<button type="button" className="button" onClick={() => { setEditing(null); setOpen(true); }}><Plus size={15} />Yangi hisob</button>} />
      {dataset.accounts.length ? (
        <>
          <div className="fin-cards">
            {balances.byCurrency.map((group) => (
              <div key={group.currency} className="fin-mini-card">
                <span>{group.currency} jami</span>
                <strong><Money amount={group.total} currency={group.currency} /></strong>
              </div>
            ))}
          </div>
          <section className="panel">
            <table className="fin-table">
              <thead><tr><th>Nomi</th><th>Turi</th><th>Valyuta</th><th className="right">Boshlang‘ich</th><th className="right">Joriy</th><th>Holat</th><th /></tr></thead>
              <tbody>
                {dataset.accounts.map((account) => (
                  <tr key={account.id} className={account.status === "ARCHIVED" ? "fin-row-archived" : ""}>
                    <td>{account.name}</td>
                    <td>{ACCOUNT_TYPE_LABELS[account.type]}</td>
                    <td>{account.currency}</td>
                    <td className="right"><Money amount={account.openingBalance} currency={account.currency} /></td>
                    <td className="right"><Money amount={account.currentBalance} currency={account.currency} /></td>
                    <td><StatusBadge status={account.status} /></td>
                    <td className="right fin-row-actions">
                      <button type="button" className="button small secondary" onClick={() => { setEditing(account); setOpen(true); }}>Tahrirlash</button>
                      <button type="button" className="button small secondary" onClick={() => void archive(account)}>
                        {account.status === "ARCHIVED" ? "Tiklash" : "Arxivlash"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      ) : <EmptyState title="Hisob yo‘q" hint="Pul qayerda turganini ko‘rish uchun birinchi hisobni qo‘shing."
            action={<button type="button" className="button" onClick={() => { setEditing(null); setOpen(true); }}>Yangi hisob</button>} />}
      {open && (
        <AccountDrawer open={open} account={editing} onClose={() => setOpen(false)}
          onSave={async (body, id) => { if (id) await adapter.updateAccount(id, body); else await adapter.createAccount(body); await onChanged(); }} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- categories ---

function CategoriesTab({ dataset, adapter, onChanged }: { dataset: FinanceDataset; adapter: FinanceAdapter; onChanged: () => Promise<void> }) {
  const [kind, setKind] = useState<CategoryKind>("EXPENSE");
  const [editing, setEditing] = useState<FinanceCategory | null>(null);
  const [open, setOpen] = useState(false);
  const tree = categoryTree(dataset.categories, kind);

  const archive = async (category: FinanceCategory) => {
    await adapter.updateCategory(category.id, { status: category.status === "ARCHIVED" ? "ACTIVE" : "ARCHIVED" });
    await onChanged();
  };

  return (
    <div className="fin-stack">
      <SectionHeading title="Kategoriyalar" subtitle="Kirim va chiqim kategoriyalari aralashmaydi"
        action={<button type="button" className="button" onClick={() => { setEditing(null); setOpen(true); }}><Plus size={15} />Yangi kategoriya</button>} />
      <div className="fin-type-switch" role="group" aria-label="Kategoriya turi">
        <button type="button" className={kind === "EXPENSE" ? "active" : ""} onClick={() => setKind("EXPENSE")}>Chiqim kategoriyalari</button>
        <button type="button" className={kind === "INCOME" ? "active" : ""} onClick={() => setKind("INCOME")}>Kirim kategoriyalari</button>
      </div>
      {tree.length ? (
        <section className="panel">
          <ul className="fin-tree">
            {tree.map(({ parent, children }) => (
              <li key={parent.id}>
                <div className={`fin-tree-row ${parent.status === "ARCHIVED" ? "fin-row-archived" : ""}`}>
                  <span className="fin-tree-name"><Layers size={13} aria-hidden="true" />{parent.name}</span>
                  <StatusBadge status={parent.status} />
                  <span className="fin-row-actions">
                    <button type="button" className="button small secondary" onClick={() => { setEditing(parent); setOpen(true); }}>Tahrirlash</button>
                    <button type="button" className="button small secondary" onClick={() => void archive(parent)}>
                      {parent.status === "ARCHIVED" ? "Tiklash" : "Arxivlash"}
                    </button>
                  </span>
                </div>
                {children.length > 0 && (
                  <ul className="fin-subtree">
                    {children.map((child) => (
                      <li key={child.id} className={`fin-tree-row ${child.status === "ARCHIVED" ? "fin-row-archived" : ""}`}>
                        <span className="fin-tree-name sub">{child.name}</span>
                        <StatusBadge status={child.status} />
                        <span className="fin-row-actions">
                          <button type="button" className="button small secondary" onClick={() => { setEditing(child); setOpen(true); }}>Tahrirlash</button>
                          <button type="button" className="button small secondary" onClick={() => void archive(child)}>
                            {child.status === "ARCHIVED" ? "Tiklash" : "Arxivlash"}
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : <EmptyState title="Kategoriya yo‘q" hint="Pul qayerga ketayotganini ko‘rish uchun kategoriya qo‘shing." />}
      {open && (
        <CategoryDrawer open={open} kind={editing?.kind ?? kind} category={editing} categories={dataset.categories}
          onClose={() => setOpen(false)}
          onSave={async (body, id) => { if (id) await adapter.updateCategory(id, body); else await adapter.createCategory(body); await onChanged(); }} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ projects ---

function ProjectsTab({ dataset, range, adapter, onChanged }: {
  dataset: FinanceDataset; range: FinanceRange; adapter: FinanceAdapter; onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<FinanceProject | null>(null);
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => projectSpending(filterTransactions(dataset.transactions, range), dataset.projects), [dataset, range]);

  const archive = async (project: FinanceProject) => {
    await adapter.updateProject(project.id, { status: project.status === "ARCHIVED" ? "ACTIVE" : "ARCHIVED" });
    await onChanged();
  };

  return (
    <div className="fin-stack">
      <SectionHeading title="Projectlar" subtitle="Finance cost-center — yozuvda Project bo‘lmasligi ham mumkin"
        action={<button type="button" className="button" onClick={() => { setEditing(null); setOpen(true); }}><Plus size={15} />Yangi Project</button>} />
      <section className="panel">
        <SectionHeading title="Tanlangan davr natijasi" />
        <ProjectTable rows={rows} />
      </section>
      {dataset.projects.length ? (
        <section className="panel">
          <SectionHeading title="Ro‘yxat" />
          <table className="fin-table">
            <thead><tr><th>Nomi</th><th>Izoh</th><th>Holat</th><th /></tr></thead>
            <tbody>
              {dataset.projects.map((project) => (
                <tr key={project.id} className={project.status === "ARCHIVED" ? "fin-row-archived" : ""}>
                  <td><FolderKanban size={13} aria-hidden="true" /> {project.name}</td>
                  <td>{project.description || "—"}</td>
                  <td><StatusBadge status={project.status} /></td>
                  <td className="right fin-row-actions">
                    <button type="button" className="button small secondary" onClick={() => { setEditing(project); setOpen(true); }}>Tahrirlash</button>
                    <button type="button" className="button small secondary" onClick={() => void archive(project)}>
                      {project.status === "ARCHIVED" ? "Tiklash" : "Arxivlash"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : <EmptyState title="Project yo‘q" hint="Xarajatni yo‘nalishlar bo‘yicha ko‘rish uchun Project qo‘shing." />}
      {open && (
        <ProjectDrawer open={open} project={editing} onClose={() => setOpen(false)}
          onSave={async (body, id) => { if (id) await adapter.updateProject(id, body); else await adapter.createProject(body); await onChanged(); }} />
      )}
    </div>
  );
}

// ------------------------------------------------------------- subscriptions ---

function SubscriptionTable({ rows, dataset, today }: { rows: readonly FinanceSubscription[]; dataset: FinanceDataset; today: string }) {
  const accountName = (id: string) => dataset.accounts.find((a) => a.id === id)?.name ?? "—";
  const categoryName = (id: string | null) => dataset.categories.find((c) => c.id === id)?.name ?? "—";
  const projectName = (id: string | null) => dataset.projects.find((p) => p.id === id)?.name ?? "—";
  return (
    <table className="fin-table">
      <thead><tr><th>Nomi</th><th className="right">Summa</th><th>Hisob</th><th>Kategoriya</th><th>Project</th><th>Davriylik</th><th>Keyingi to‘lov</th></tr></thead>
      <tbody>
        {rows.map((row) => {
          const months = cadenceMonths(row);
          const overdue = row.status === "ACTIVE" && row.nextDueDate < today;
          return (
            <tr key={row.id} className={row.status === "ARCHIVED" ? "fin-row-archived" : ""}>
              <td>{row.name}{row.status === "ARCHIVED" && <> <ArchivedBadge /></>}</td>
              <td className="right"><Money amount={row.amount} currency={row.currency} tone="expense" /></td>
              <td>{accountName(row.accountId)}</td>
              <td>{categoryName(row.categoryId)}</td>
              <td>{projectName(row.projectId)}</td>
              <td>{row.cadence === "CUSTOM_MONTHS" && months ? `Har ${months} oy` : CADENCE_LABELS[row.cadence]}</td>
              <td>{row.nextDueDate}{overdue && <span className="fin-badge overdue">Kechikkan</span>}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SubscriptionsTab({ dataset, adapter, onChanged }: { dataset: FinanceDataset; adapter: FinanceAdapter; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState<FinanceSubscription | null>(null);
  const [open, setOpen] = useState(false);
  const today = todayKey();
  const buckets = useMemo(() => subscriptionBuckets(dataset.subscriptions, { today }), [dataset.subscriptions, today]);

  const archive = async (subscription: FinanceSubscription) => {
    await adapter.updateSubscription(subscription.id, { status: subscription.status === "ARCHIVED" ? "ACTIVE" : "ARCHIVED" });
    await onChanged();
  };

  const groups: { key: string; title: string; hint?: string; rows: FinanceSubscription[] }[] = [
    { key: "overdue", title: "Kechikkan", rows: buckets.overdue },
    { key: "upcoming", title: "Yaqin 30 kun", rows: buckets.upcoming },
    { key: "later", title: "Keyinroq", rows: buckets.later },
    { key: "archived", title: "Arxivlangan", rows: buckets.archived },
  ];

  return (
    <div className="fin-stack">
      <SectionHeading title="Obunalar" subtitle="Obuna — takrorlanuvchi to‘lov shabloni. To‘lov avtomatik yaratilmaydi, uni qo‘lda kiritasiz."
        action={<button type="button" className="button" onClick={() => { setEditing(null); setOpen(true); }}><Plus size={15} />Yangi obuna</button>} />
      <div className="kpi-grid fin-kpi-grid">
        <CurrencyKpiRow label="Kutilayotgan to‘lov" value={buckets.upcomingByCurrency} tone="expense"
          icon={<CalendarClock size={15} />} note="Kechikkan + yaqin 30 kun" />
      </div>
      {dataset.subscriptions.length ? groups.map((group) => (
        group.rows.length ? (
          <section key={group.key} className="panel">
            <SectionHeading title={`${group.title} (${group.rows.length})`} />
            <SubscriptionTable rows={group.rows} dataset={dataset} today={today} />
            <div className="fin-row-actions fin-subs-actions">
              {group.rows.map((row) => (
                <span key={row.id} className="fin-subs-action">
                  <button type="button" className="button small secondary" onClick={() => { setEditing(row); setOpen(true); }}>{row.name}: tahrirlash</button>
                  <button type="button" className="button small secondary" onClick={() => void archive(row)}>
                    {row.status === "ARCHIVED" ? "Tiklash" : "Arxivlash"}
                  </button>
                </span>
              ))}
            </div>
          </section>
        ) : null
      )) : <EmptyState title="Obuna yo‘q" hint="Takrorlanuvchi to‘lovlarni eslatma sifatida qo‘shing."
            action={<button type="button" className="button" onClick={() => { setEditing(null); setOpen(true); }}>Yangi obuna</button>} />}
      {open && (
        <SubscriptionDrawer open={open} subscription={editing} dataset={dataset} onClose={() => setOpen(false)}
          onSave={async (body, id) => { if (id) await adapter.updateSubscription(id, body); else await adapter.createSubscription(body); await onChanged(); }} />
      )}
    </div>
  );
}

export { addDays };
