"use client";

import { useMemo, useState } from "react";

import { Drawer } from "../ui/drawer";
import { DateInput, FormField, NumberInput, SelectInput, TextInput, Textarea } from "../ui/form";
import { useFinanceCurrency } from "./finance-primitives";
import { formatMoney, moneyInputStep, moneyInputValue, parseMoneyInput } from "@/lib/finance-money";
import { buildTransactionBody, cadenceMonths, selectableCategories, transferShape, validateTransaction } from "@/lib/finance-metrics";
import { validateSubscriptionInput } from "@/lib/finance/validation";
import {
  ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS, CADENCES, CADENCE_LABELS, CURRENCIES,
  TRANSACTION_TYPES, TRANSACTION_TYPE_LABELS,
  type AccountType, type Cadence, type CategoryKind, type Currency, type FinanceAccount,
  type FinanceCategory, type FinanceDataset, type FinanceProject, type FinanceSubscription,
  type FinanceTransaction, type NewAccount, type NewCategory, type NewProject,
  type NewSubscription, type NewTransaction, type TransactionType,
} from "@/lib/finance-types";

const today = () => new Date().toISOString().slice(0, 10);
const activeOnly = <T extends { archived: boolean }>(rows: readonly T[]) => rows.filter((row) => !row.archived);

function DrawerFooter({ onCancel, onSave, saving, saveLabel = "Saqlash" }: {
  onCancel: () => void; onSave: () => void; saving: boolean; saveLabel?: string;
}) {
  return (
    <>
      <button type="button" className="button secondary" onClick={onCancel} disabled={saving}>Bekor qilish</button>
      <button type="button" className="button" onClick={onSave} disabled={saving}>{saving ? "Saqlanmoqda…" : saveLabel}</button>
    </>
  );
}

/**
 * Transaction drawer: Kirim, Chiqim or O‘tkazma.
 *
 * The transfer rule that matters: when the two accounts hold different
 * currencies the user enters BOTH amounts. No rate is applied and no second
 * amount is derived — the app does not know today's rate and guessing it would
 * silently invent money.
 */
export function TransactionDrawer({ open, dataset, initialType = "EXPENSE", onClose, onSave }: {
  open: boolean;
  dataset: FinanceDataset;
  initialType?: TransactionType;
  onClose: () => void;
  onSave: (body: NewTransaction) => Promise<void>;
}) {
  const accounts = useMemo(() => activeOnly(dataset.accounts), [dataset.accounts]);
  const projects = useMemo(() => activeOnly(dataset.projects), [dataset.projects]);
  const [type, setType] = useState<TransactionType>(initialType);
  const [date, setDate] = useState(today());
  const [accountId, setAccountId] = useState("");
  const [toAccountId, setToAccountId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [toAmount, setToAmount] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const from = accounts.find((account) => account.id === accountId) ?? null;
  const to = accounts.find((account) => account.id === toAccountId) ?? null;
  const fromCurrency = useFinanceCurrency(from?.currencyCode);
  const toCurrency = useFinanceCurrency(to?.currencyCode);
  const crossCurrency = type === "TRANSFER" && transferShape(from, to).crossCurrency;
  const categories = useMemo(() => selectableCategories(dataset.categories, type), [dataset.categories, type]);
  const dirty = Boolean(accountId || amount || description);

  const reset = () => {
    setType(initialType); setDate(today()); setAccountId(""); setToAccountId("");
    setCategoryId(""); setProjectId(""); setDescription(""); setAmount(""); setToAmount(""); setError(null);
  };

  const save = async () => {
    // Validation and body shape live in lib/finance-metrics so they are testable
    // without rendering, and so the transfer rule has exactly one definition.
    const draft = {
      type, date, accountId, toAccountId: toAccountId || null,
      amountMinor: fromCurrency && amount !== "" ? parseMoneyInput(amount, fromCurrency) : null,
      destinationAmountMinor: toCurrency && toAmount !== "" ? parseMoneyInput(toAmount, toCurrency) : null,
      categoryId: categoryId || null, projectId: projectId || null,
    };
    const check = validateTransaction(draft, accounts);
    if (!check.ok) return setError(check.error);
    setSaving(true); setError(null);
    try {
      await onSave(buildTransactionBody(draft, accounts, description.trim()) as NewTransaction);
      reset(); onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Saqlanmadi");
    } finally { setSaving(false); }
  };

  return (
    <Drawer open={open} title="Yangi yozuv" context="Finance" dirty={dirty && !saving} onClose={() => { reset(); onClose(); }}
      footer={<DrawerFooter onCancel={() => { reset(); onClose(); }} onSave={save} saving={saving} />}>
      <div className="fin-type-switch" role="group" aria-label="Yozuv turi">
        {TRANSACTION_TYPES.map((option) => (
          <button key={option} type="button" className={type === option ? "active" : ""}
            onClick={() => { setType(option); setCategoryId(""); setToAccountId(""); setToAmount(""); }}>
            {TRANSACTION_TYPE_LABELS[option]}
          </button>
        ))}
      </div>

      <FormField label="Sana" required><DateInput value={date} onChange={(event) => setDate(event.target.value)} data-autofocus /></FormField>

      <FormField label={type === "TRANSFER" ? "Qaysi hisobdan" : "Hisob"} required>
        <SelectInput value={accountId} onChange={(event) => setAccountId(event.target.value)}>
          <option value="">Tanlang</option>
          {accounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.currencyCode}</option>)}
        </SelectInput>
      </FormField>

      {type === "TRANSFER" && (
        <FormField label="Qaysi hisobga" required>
          <SelectInput value={toAccountId} onChange={(event) => setToAccountId(event.target.value)}>
            <option value="">Tanlang</option>
            {accounts.filter((account) => account.id !== accountId).map((account) => (
              <option key={account.id} value={account.id}>{account.name} · {account.currencyCode}</option>
            ))}
          </SelectInput>
        </FormField>
      )}

      <FormField label={crossCurrency ? `Yuboriladigan summa (${from?.currencyCode})` : "Summa"} required
        hint={from ? `Valyuta: ${from.currencyCode}` : undefined}>
        <NumberInput value={amount} min="0" step={fromCurrency ? moneyInputStep(fromCurrency) : "any"}
          onChange={(event) => setAmount(event.target.value)} />
      </FormField>

      {crossCurrency && (
        <FormField label={`Tushadigan summa (${to?.currencyCode})`} required
          hint="Valyutalar farq qiladi — ikkala summani o‘zingiz kiritasiz. Kurs avtomatik hisoblanmaydi.">
          <NumberInput value={toAmount} min="0" step={toCurrency ? moneyInputStep(toCurrency) : "any"}
            onChange={(event) => setToAmount(event.target.value)} />
        </FormField>
      )}

      {type !== "TRANSFER" && (
        <>
          <FormField label="Kategoriya" required>
            <SelectInput value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
              <option value="">Tanlang</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>{category.parentId ? "— " : ""}{category.name}</option>
              ))}
            </SelectInput>
          </FormField>
        </>
      )}

      <FormField label="Project" hint="Ixtiyoriy — Project tanlanmasa ham yozuv saqlanadi">
        <SelectInput value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          <option value="">Project belgilanmagan</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </SelectInput>
      </FormField>

      <FormField label="Izoh"><Textarea value={description} onChange={(event) => setDescription(event.target.value)} /></FormField>
      {error && <p className="form-error" role="alert">{error}</p>}
    </Drawer>
  );
}

export function AccountDrawer({ open, account, onClose, onSave }: {
  open: boolean;
  account: FinanceAccount | null;
  onClose: () => void;
  onSave: (body: NewAccount, id: string | null) => Promise<void>;
}) {
  const [name, setName] = useState(account?.name ?? "");
  const [type, setType] = useState<AccountType>(account?.type ?? "CASH");
  const [currency, setCurrency] = useState<Currency>((account?.currencyCode as Currency) ?? "UZS");
  const currencyDefinition = useFinanceCurrency(currency);
  const [openingBalance, setOpeningBalance] = useState(account && currencyDefinition ? moneyInputValue(account.openingBalanceMinor, currencyDefinition) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim()) return setError("Nomini kiriting");
    setSaving(true); setError(null);
    try {
      if (!currencyDefinition) return setError("Valyuta metama’lumoti topilmadi");
      const openingBalanceMinor = openingBalance === "" && account
        ? account.openingBalanceMinor
        : parseMoneyInput(openingBalance || "0", currencyDefinition);
      if (openingBalanceMinor === null) return setError("Boshlang‘ich balans noto‘g‘ri");
      await onSave({ name: name.trim(), type, currencyCode: currency, openingBalanceMinor, archived: account?.archived ?? false }, account?.id ?? null);
      onClose();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Saqlanmadi"); }
    finally { setSaving(false); }
  };

  return (
    <Drawer open={open} title={account ? "Hisobni tahrirlash" : "Yangi hisob"} context="Finance" dirty={Boolean(name) && !saving}
      onClose={onClose} footer={<DrawerFooter onCancel={onClose} onSave={save} saving={saving} />}>
      <FormField label="Nomi" required><TextInput value={name} onChange={(event) => setName(event.target.value)} data-autofocus /></FormField>
      <FormField label="Turi" required>
        <SelectInput value={type} onChange={(event) => setType(event.target.value as AccountType)}>
          {ACCOUNT_TYPES.map((option) => <option key={option} value={option}>{ACCOUNT_TYPE_LABELS[option]}</option>)}
        </SelectInput>
      </FormField>
      <FormField label="Valyuta" required hint={account ? "Mavjud hisobning valyutasini o‘zgartirish balanslarni buzadi" : undefined}>
        <SelectInput value={currency} onChange={(event) => setCurrency(event.target.value as Currency)} disabled={Boolean(account)}>
          {CURRENCIES.map((option) => <option key={option} value={option}>{option}</option>)}
        </SelectInput>
      </FormField>
      <FormField label="Boshlang‘ich balans" hint="Joriy balans yozuvlardan hisoblanadi — qo‘lda tahrirlanmaydi">
        <NumberInput value={openingBalance} step={currencyDefinition ? moneyInputStep(currencyDefinition) : "any"}
          onChange={(event) => setOpeningBalance(event.target.value)} disabled={Boolean(account)} />
      </FormField>
      {account && currencyDefinition && <p className="field-hint">Saqlangan boshlang‘ich balans: {formatMoney(account.openingBalanceMinor, currencyDefinition)}. Joriy balans faqat server summary’dan o‘qiladi.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </Drawer>
  );
}

/**
 * Category drawer. A subcategory can only sit under a parent of its own kind, so
 * an expense can never be filed under an income tree.
 */
export function CategoryDrawer({ open, kind, category, categories, onClose, onSave }: {
  open: boolean;
  kind: CategoryKind;
  category: FinanceCategory | null;
  categories: readonly FinanceCategory[];
  onClose: () => void;
  onSave: (body: NewCategory, id: string | null) => Promise<void>;
}) {
  const [name, setName] = useState(category?.name ?? "");
  const [parentId, setParentId] = useState(category?.parentId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Same kind, top level only, and never itself.
  const parents = categories.filter((item) => item.kind === kind && item.parentId === null && !item.archived && item.id !== category?.id);

  const save = async () => {
    if (!name.trim()) return setError("Nomini kiriting");
    setSaving(true); setError(null);
    try {
      await onSave({ name: name.trim(), kind, parentId: parentId || null, archived: category?.archived ?? false, sortOrder: category?.sortOrder ?? 0 }, category?.id ?? null);
      onClose();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Saqlanmadi"); }
    finally { setSaving(false); }
  };

  return (
    <Drawer open={open} title={category ? "Kategoriyani tahrirlash" : "Yangi kategoriya"}
      context={kind === "INCOME" ? "Kirim" : "Chiqim"} dirty={Boolean(name) && !saving} onClose={onClose}
      footer={<DrawerFooter onCancel={onClose} onSave={save} saving={saving} />}>
      <FormField label="Nomi" required><TextInput value={name} onChange={(event) => setName(event.target.value)} data-autofocus /></FormField>
      <FormField label="Asosiy kategoriya" hint={`Faqat ${kind === "INCOME" ? "kirim" : "chiqim"} kategoriyalari ko‘rsatiladi`}>
        <SelectInput value={parentId} onChange={(event) => setParentId(event.target.value)}>
          <option value="">Asosiy kategoriya (subkategoriya emas)</option>
          {parents.map((parent) => <option key={parent.id} value={parent.id}>{parent.name}</option>)}
        </SelectInput>
      </FormField>
      {error && <p className="form-error" role="alert">{error}</p>}
    </Drawer>
  );
}

export function ProjectDrawer({ open, project, onClose, onSave }: {
  open: boolean;
  project: FinanceProject | null;
  onClose: () => void;
  onSave: (body: NewProject, id: string | null) => Promise<void>;
}) {
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim()) return setError("Nomini kiriting");
    setSaving(true); setError(null);
    try {
      await onSave({ name: name.trim(), description: description.trim() || null, archived: project?.archived ?? false }, project?.id ?? null);
      onClose();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Saqlanmadi"); }
    finally { setSaving(false); }
  };

  return (
    <Drawer open={open} title={project ? "Projectni tahrirlash" : "Yangi Project"} context="Finance"
      dirty={Boolean(name) && !saving} onClose={onClose} footer={<DrawerFooter onCancel={onClose} onSave={save} saving={saving} />}>
      <FormField label="Nomi" required><TextInput value={name} onChange={(event) => setName(event.target.value)} data-autofocus /></FormField>
      <FormField label="Izoh"><Textarea value={description} onChange={(event) => setDescription(event.target.value)} /></FormField>
      {error && <p className="form-error" role="alert">{error}</p>}
    </Drawer>
  );
}

/**
 * Subscription drawer.
 *
 * Copy is deliberately "Keyingi to‘lov" — the MVP subscription records an
 * expectation. It does not create a transaction and the wording must not suggest
 * money leaves an account on its own.
 */
export function SubscriptionDrawer({ open, subscription, dataset, onClose, onSave }: {
  open: boolean;
  subscription: FinanceSubscription | null;
  dataset: FinanceDataset;
  onClose: () => void;
  onSave: (body: NewSubscription, id: string | null) => Promise<void>;
}) {
  const accounts = activeOnly(dataset.accounts);
  const projects = activeOnly(dataset.projects);
  const [direction, setDirection] = useState<CategoryKind>(subscription?.direction ?? "EXPENSE");
  const categories = dataset.categories.filter((category) => category.kind === direction && !category.archived);
  const [name, setName] = useState(subscription?.name ?? "");
  const [accountId, setAccountId] = useState(subscription?.accountId ?? "");
  const [amount, setAmount] = useState(subscription ? moneyInputValue(subscription.amountMinor, subscription.currencyCode as Currency) : "");
  const [categoryId, setCategoryId] = useState(subscription?.categoryId ?? "");
  const [projectId, setProjectId] = useState(subscription?.projectId ?? "");
  const [cadence, setCadence] = useState<Cadence>(subscription?.cadence ?? "MONTHLY");
  const [intervalMonths, setIntervalMonths] = useState(String(subscription?.intervalMonths ?? ""));
  const [nextDueDate, setNextDueDate] = useState(subscription?.nextDueDate ?? today());
  const [startDate, setStartDate] = useState(subscription?.startDate ?? today());
  const [endDate, setEndDate] = useState(subscription?.endDate ?? "");
  const [note, setNote] = useState(subscription?.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const account = accounts.find((item) => item.id === accountId) ?? null;
  const currencyDefinition = useFinanceCurrency(account?.currencyCode);

  const save = async () => {
    if (!name.trim()) return setError("Nomini kiriting");
    if (!accountId) return setError("Hisobni tanlang");
    if (!categoryId) return setError("Kategoriyani tanlang");
    if (!currencyDefinition) return setError("Valyuta metama’lumoti topilmadi");
    const currencyCode = currencyDefinition.code as Currency;
    const amountMinor = parseMoneyInput(amount, currencyDefinition);
    if (amountMinor === null || amountMinor <= 0) return setError("Summani kiriting");
    const body: NewSubscription = {
      name: name.trim(), direction, amountMinor, currencyCode,
      accountId, categoryId, projectId: projectId || null, cadence,
      intervalMonths: cadence === "CUSTOM_MONTHS" ? Number(intervalMonths) || null : null,
      nextDueDate, startDate, endDate: endDate || null, archived: subscription?.archived ?? false,
      note: note.trim() || null,
    };
    if (cadence === "CUSTOM_MONTHS" && cadenceMonths(body) === null) return setError("Necha oyda bir to‘lanadi?");
    const validated = validateSubscriptionInput(body);
    if (!validated.ok) return setError(validated.error);
    setSaving(true); setError(null);
    try { await onSave(validated.value, subscription?.id ?? null); onClose(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Saqlanmadi"); }
    finally { setSaving(false); }
  };

  return (
    <Drawer open={open} title={subscription ? "Obunani tahrirlash" : "Yangi obuna"} context="Finance"
      dirty={Boolean(name) && !saving} onClose={onClose} footer={<DrawerFooter onCancel={onClose} onSave={save} saving={saving} />}>
      <FormField label="Nomi" required><TextInput value={name} onChange={(event) => setName(event.target.value)} data-autofocus /></FormField>
      <FormField label="Yo‘nalish" required>
        <SelectInput value={direction} onChange={(event) => { setDirection(event.target.value as CategoryKind); setCategoryId(""); }}>
          <option value="EXPENSE">Chiqim</option><option value="INCOME">Kirim</option>
        </SelectInput>
      </FormField>
      <FormField label="Hisob" required>
        <SelectInput value={accountId} onChange={(event) => setAccountId(event.target.value)}>
          <option value="">Tanlang</option>
          {accounts.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.currencyCode}</option>)}
        </SelectInput>
      </FormField>
      <FormField label="Summa" required hint={account ? `Valyuta: ${account.currencyCode}` : undefined}>
        <NumberInput value={amount} min="0" step={currencyDefinition ? moneyInputStep(currencyDefinition) : "any"}
          onChange={(event) => setAmount(event.target.value)} />
      </FormField>
      <FormField label="Kategoriya" required>
        <SelectInput value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
          <option value="">Tanlang</option>
          {categories.map((category) => <option key={category.id} value={category.id}>{category.parentId ? "— " : ""}{category.name}</option>)}
        </SelectInput>
      </FormField>
      <FormField label="Project" hint="Ixtiyoriy">
        <SelectInput value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          <option value="">Project belgilanmagan</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </SelectInput>
      </FormField>
      <FormField label="Davriylik" required>
        <SelectInput value={cadence} onChange={(event) => setCadence(event.target.value as Cadence)}>
          {CADENCES.map((option) => <option key={option} value={option}>{CADENCE_LABELS[option]}</option>)}
        </SelectInput>
      </FormField>
      {cadence === "CUSTOM_MONTHS" && (
        <FormField label="Necha oyda bir" required>
          <NumberInput value={intervalMonths} min="1" step="1" onChange={(event) => setIntervalMonths(event.target.value)} />
        </FormField>
      )}
      <FormField label="Keyingi to‘lov sanasi" required
        hint="Bu faqat eslatma. Obuna yozuvni o‘zi yaratmaydi — to‘lovni qo‘lda kiritasiz.">
        <DateInput value={nextDueDate} onChange={(event) => setNextDueDate(event.target.value)} />
      </FormField>
      <FormField label="Boshlanish sanasi" required><DateInput value={startDate} onChange={(event) => setStartDate(event.target.value)} /></FormField>
      <FormField label="Tugash sanasi" hint="Ixtiyoriy"><DateInput value={endDate} onChange={(event) => setEndDate(event.target.value)} /></FormField>
      <FormField label="Izoh"><Textarea value={note} onChange={(event) => setNote(event.target.value)} /></FormField>
      {error && <p className="form-error" role="alert">{error}</p>}
    </Drawer>
  );
}

export type { FinanceTransaction };
