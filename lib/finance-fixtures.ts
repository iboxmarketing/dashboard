import { FINANCE_CURRENCIES } from "./finance/money";
import { buildFinanceSummary } from "./finance/summary";
import type { FinanceDataset } from "./finance-types";

const CREATED = "2026-09-01T00:00:00.000Z";
const timestamps = { createdAt: CREATED, updatedAt: CREATED };

const core: Omit<FinanceDataset, "summary"> = {
  currencies: FINANCE_CURRENCIES.map((currency) => ({ ...currency, archived: false })),
  accounts: [
    { id: "acc-1", name: "Asosiy kassa", type: "CASH", currencyCode: "UZS", openingBalanceMinor: 4_000_000_000, archived: false, ...timestamps },
    { id: "acc-2", name: "Kapitalbank hisob", type: "BANK", currencyCode: "UZS", openingBalanceMinor: 1_000_000_000, archived: false, ...timestamps },
    { id: "acc-3", name: "Payme karta", type: "CARD", currencyCode: "UZS", openingBalanceMinor: 0, archived: false, ...timestamps },
    { id: "acc-4", name: "USD hisob", type: "BANK", currencyCode: "USD", openingBalanceMinor: 100_000, archived: false, ...timestamps },
    { id: "acc-5", name: "Eski hamyon", type: "OTHER", currencyCode: "UZS", openingBalanceMinor: 50_000_000, archived: true, ...timestamps },
  ],
  categories: [
    { id: "cat-in-1", name: "Mijoz to‘lovi", kind: "INCOME", parentId: null, archived: false, sortOrder: 1 },
    { id: "cat-in-2", name: "Obuna to‘lovi", kind: "INCOME", parentId: "cat-in-1", archived: false, sortOrder: 2 },
    { id: "cat-ex-1", name: "Ish haqi", kind: "EXPENSE", parentId: null, archived: false, sortOrder: 3 },
    { id: "cat-ex-2", name: "Marketing", kind: "EXPENSE", parentId: null, archived: false, sortOrder: 4 },
    { id: "cat-ex-3", name: "Reklama", kind: "EXPENSE", parentId: "cat-ex-2", archived: false, sortOrder: 5 },
    { id: "cat-ex-4", name: "Kontent", kind: "EXPENSE", parentId: "cat-ex-2", archived: false, sortOrder: 6 },
    { id: "cat-ex-5", name: "Ofis", kind: "EXPENSE", parentId: null, archived: false, sortOrder: 7 },
  ],
  projects: [
    { id: "prj-1", name: "IBOX platforma", description: "Asosiy mahsulot", archived: false, ...timestamps },
    { id: "prj-2", name: "SD yo‘nalishi", description: "Ikkinchi brend", archived: false, ...timestamps },
    { id: "prj-3", name: "Yopilgan tashabbus", description: null, archived: true, ...timestamps },
  ],
  transactions: [
    { id: "tx-1", date: "2026-09-02", type: "INCOME", note: "Sentyabr mijoz to‘lovlari", projectId: "prj-1", accountId: "acc-2", amountMinor: 4_200_000_000, currencyCode: "UZS", categoryId: "cat-in-1", fromAccountId: null, toAccountId: null, sourceAmountMinor: null, sourceCurrencyCode: null, destinationAmountMinor: null, destinationCurrencyCode: null, ...timestamps },
    { id: "tx-2", date: "2026-09-04", type: "EXPENSE", note: "Sentyabr ish haqi", projectId: "prj-1", accountId: "acc-1", amountMinor: 2_850_000_000, currencyCode: "UZS", categoryId: "cat-ex-1", fromAccountId: null, toAccountId: null, sourceAmountMinor: null, sourceCurrencyCode: null, destinationAmountMinor: null, destinationCurrencyCode: null, ...timestamps },
    { id: "tx-3", date: "2026-09-05", type: "EXPENSE", note: "Instagram reklama", projectId: "prj-2", accountId: "acc-3", amountMinor: 480_000_000, currencyCode: "UZS", categoryId: "cat-ex-3", fromAccountId: null, toAccountId: null, sourceAmountMinor: null, sourceCurrencyCode: null, destinationAmountMinor: null, destinationCurrencyCode: null, ...timestamps },
    { id: "tx-4", date: "2026-09-08", type: "EXPENSE", note: "Kontent ishlab chiqish", projectId: null, accountId: "acc-3", amountMinor: 215_000_000, currencyCode: "UZS", categoryId: "cat-ex-4", fromAccountId: null, toAccountId: null, sourceAmountMinor: null, sourceCurrencyCode: null, destinationAmountMinor: null, destinationCurrencyCode: null, ...timestamps },
    { id: "tx-5", date: "2026-09-10", type: "INCOME", note: "Xalqaro obuna", projectId: "prj-2", accountId: "acc-4", amountMinor: 180_000, currencyCode: "USD", categoryId: "cat-in-2", fromAccountId: null, toAccountId: null, sourceAmountMinor: null, sourceCurrencyCode: null, destinationAmountMinor: null, destinationCurrencyCode: null, ...timestamps },
    { id: "tx-6", date: "2026-09-12", type: "TRANSFER", note: "Kassadan bankka", projectId: null, accountId: null, amountMinor: null, currencyCode: null, categoryId: null, fromAccountId: "acc-1", toAccountId: "acc-2", sourceAmountMinor: 1_500_000_000, sourceCurrencyCode: "UZS", destinationAmountMinor: 1_500_000_000, destinationCurrencyCode: "UZS", ...timestamps },
    { id: "tx-7", date: "2026-09-14", type: "TRANSFER", note: "Valyuta ayirboshlash", projectId: null, accountId: null, amountMinor: null, currencyCode: null, categoryId: null, fromAccountId: "acc-2", toAccountId: "acc-4", sourceAmountMinor: 1_260_000_000, sourceCurrencyCode: "UZS", destinationAmountMinor: 100_000, destinationCurrencyCode: "USD", ...timestamps },
    { id: "tx-8", date: "2026-09-16", type: "EXPENSE", note: "Ofis ijarasi", projectId: null, accountId: "acc-2", amountMinor: 900_000_000, currencyCode: "UZS", categoryId: "cat-ex-5", fromAccountId: null, toAccountId: null, sourceAmountMinor: null, sourceCurrencyCode: null, destinationAmountMinor: null, destinationCurrencyCode: null, ...timestamps },
    { id: "tx-9", date: "2026-09-17", type: "EXPENSE", note: "Xalqaro reklama platformasi", projectId: "prj-2", accountId: "acc-4", amountMinor: 64_000, currencyCode: "USD", categoryId: "cat-ex-2", fromAccountId: null, toAccountId: null, sourceAmountMinor: null, sourceCurrencyCode: null, destinationAmountMinor: null, destinationCurrencyCode: null, ...timestamps },
  ],
  subscriptions: [
    { id: "sub-1", name: "Bitrix24", direction: "EXPENSE", accountId: "acc-2", categoryId: "cat-ex-5", projectId: "prj-1", amountMinor: 145_000_000, currencyCode: "UZS", cadence: "MONTHLY", intervalMonths: null, nextDueDate: "2026-09-25", startDate: "2026-01-01", endDate: null, archived: false, note: null, ...timestamps },
    { id: "sub-2", name: "Cloudflare", direction: "EXPENSE", accountId: "acc-4", categoryId: "cat-ex-5", projectId: null, amountMinor: 2_500, currencyCode: "USD", cadence: "MONTHLY", intervalMonths: null, nextDueDate: "2026-09-18", startDate: "2026-01-01", endDate: null, archived: false, note: null, ...timestamps },
    { id: "sub-3", name: "Server hosting", direction: "EXPENSE", accountId: "acc-2", categoryId: "cat-ex-5", projectId: "prj-1", amountMinor: 360_000_000, currencyCode: "UZS", cadence: "QUARTERLY", intervalMonths: null, nextDueDate: "2026-10-01", startDate: "2026-01-01", endDate: null, archived: false, note: null, ...timestamps },
    { id: "sub-4", name: "Domen", direction: "EXPENSE", accountId: "acc-4", categoryId: "cat-ex-5", projectId: null, amountMinor: 4_000, currencyCode: "USD", cadence: "YEARLY", intervalMonths: null, nextDueDate: "2027-02-11", startDate: "2026-01-01", endDate: null, archived: false, note: null, ...timestamps },
    { id: "sub-5", name: "Auditor xizmati", direction: "EXPENSE", accountId: "acc-2", categoryId: "cat-ex-5", projectId: null, amountMinor: 500_000_000, currencyCode: "UZS", cadence: "CUSTOM_MONTHS", intervalMonths: 4, nextDueDate: "2026-09-28", startDate: "2026-01-01", endDate: null, archived: false, note: null, ...timestamps },
    { id: "sub-6", name: "Eski CRM", direction: "EXPENSE", accountId: "acc-2", categoryId: "cat-ex-5", projectId: null, amountMinor: 90_000_000, currencyCode: "UZS", cadence: "MONTHLY", intervalMonths: null, nextDueDate: "2026-08-01", startDate: "2026-01-01", endDate: null, archived: true, note: null, ...timestamps },
  ],
};

export const FINANCE_FIXTURES: FinanceDataset = {
  ...core,
  summary: buildFinanceSummary({ ...core, range: { from: "2026-09-01", to: "2026-09-30" }, asOf: "2026-09-20" }),
};

export const cloneFixtures = (): FinanceDataset => structuredClone(FINANCE_FIXTURES);
